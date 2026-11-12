package model

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// BillingRefund is a durable intent to refund an already failed relay. It must
// not be created for an interrupted request whose upstream outcome is unknown.
// No API keys or request bodies are stored in this journal.
type BillingRefund struct {
	ID                    string `gorm:"type:varchar(64);primaryKey"`
	UserID                int
	TokenID               int
	WalletQuota           int    `gorm:"type:bigint"`
	TokenQuota            int    `gorm:"type:bigint"`
	SubscriptionRequestID string `gorm:"type:varchar(64)"`
	SubscriptionID        int
	SubscriptionExtra     int    `gorm:"type:bigint"`
	Status                string `gorm:"type:varchar(16);index"`
	CreatedAt             int64
	UpdatedAt             int64 `gorm:"index"`
	Attempts              int
	LastError             string `gorm:"type:text"`
}

func EnqueueBillingRefund(refund *BillingRefund) error {
	// In-memory batch debits cannot be safely reversed by a durable worker.
	if common.BatchUpdateEnabled {
		return errors.New("durable billing refunds require BATCH_UPDATE_ENABLED=false")
	}
	if refund.ID == "" || refund.UserID <= 0 || refund.WalletQuota < 0 || refund.TokenQuota < 0 || refund.SubscriptionExtra < 0 {
		return errors.New("invalid billing refund")
	}
	if refund.TokenQuota > 0 && refund.TokenID <= 0 || refund.SubscriptionExtra > 0 && refund.SubscriptionID <= 0 {
		return errors.New("invalid billing refund target")
	}
	if err := common.ValidateWalletQuota(refund.WalletQuota); err != nil {
		return err
	}
	refund.Status = "pending"
	refund.CreatedAt = common.GetTimestamp()
	refund.UpdatedAt = refund.CreatedAt
	return DB.Clauses(clause.OnConflict{DoNothing: true}).Create(refund).Error
}

// ProcessBillingRefund commits all balances and the credited marker together.
// Cache invalidation is separately retryable; a crash at either stage cannot
// credit a wallet/token/subscription twice.
func ProcessBillingRefund(id string) error {
	if common.BatchUpdateEnabled {
		return errors.New("durable billing refunds require BATCH_UPDATE_ENABLED=false")
	}
	var refund BillingRefund
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(&refund).Error; err != nil {
			return err
		}
		if refund.Status == "done" || refund.Status == "credited" {
			return nil
		}
		if refund.Status != "pending" {
			return errors.New("invalid billing refund status")
		}
		if refund.WalletQuota > 0 {
			if err := creditTopUpQuota(tx, refund.UserID, refund.WalletQuota, nil); err != nil {
				return err
			}
		}
		if refund.SubscriptionRequestID != "" {
			if err := refundSubscriptionPreConsumeTx(tx, refund.SubscriptionRequestID); err != nil {
				return err
			}
		}
		if refund.SubscriptionExtra > 0 {
			if err := postConsumeUserSubscriptionDeltaTx(tx, refund.SubscriptionID, -int64(refund.SubscriptionExtra)); err != nil {
				return err
			}
		}
		if refund.TokenQuota > 0 {
			result := tx.Unscoped().Model(&Token{}).Where("id = ? AND user_id = ?", refund.TokenID, refund.UserID).Updates(map[string]any{
				"remain_quota":  gorm.Expr("remain_quota + ?", refund.TokenQuota),
				"used_quota":    gorm.Expr("used_quota - ?", refund.TokenQuota),
				"accessed_time": common.GetTimestamp(),
			})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errors.New("billing refund token not found")
			}
		}
		refund.Status = "credited"
		return tx.Model(&refund).Updates(map[string]any{"status": "credited", "updated_at": common.GetTimestamp()}).Error
	})
	if err == nil && refund.Status != "done" {
		err = invalidateUserCache(refund.UserID)
		if err == nil && refund.TokenQuota > 0 && common.RedisEnabled {
			var token Token
			err = DB.Unscoped().Where("id = ?", refund.TokenID).First(&token).Error
			if err == nil {
				err = invalidateTokenCacheForMutation(token.Key)
			}
		}
		if err == nil {
			err = DB.Model(&BillingRefund{}).Where("id = ? AND status = ?", id, "credited").Updates(map[string]any{
				"status": "done", "updated_at": common.GetTimestamp(), "last_error": "",
			}).Error
		}
	}
	if err != nil {
		// Keep the intent pending/credited for a later worker or process restart.
		DB.Model(&BillingRefund{}).Where("id = ? AND status <> ?", id, "done").Updates(map[string]any{
			"attempts": gorm.Expr("attempts + 1"), "updated_at": common.GetTimestamp(), "last_error": err.Error(),
		})
	}
	return err
}

func RetryPendingBillingRefunds(limit int) error {
	var refunds []BillingRefund
	if err := DB.Where("status IN ?", []string{"pending", "credited"}).Order("updated_at ASC").Limit(limit).Find(&refunds).Error; err != nil {
		return err
	}
	var failures []error
	for _, refund := range refunds {
		if err := ProcessBillingRefund(refund.ID); err != nil {
			failures = append(failures, fmt.Errorf("refund %s: %w", refund.ID, err))
		}
	}
	return errors.Join(failures...)
}
