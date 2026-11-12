package model

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestPaymentAndRefundDatabaseMatrix(t *testing.T) {
	for _, dialect := range []common.DatabaseType{common.DatabaseTypeSQLite, common.DatabaseTypeMySQL, common.DatabaseTypePostgreSQL} {
		t.Run(string(dialect), func(t *testing.T) {
			var driver gorm.Dialector = sqlite.Open(":memory:")
			if dialect == common.DatabaseTypeMySQL {
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
			} else if dialect == common.DatabaseTypePostgreSQL {
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "refund_test_"}})
			require.NoError(t, err)
			conn, err := db.DB()
			require.NoError(t, err)
			conn.SetMaxOpenConns(1)
			oldDB, oldLogDB := DB, LOG_DB
			oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
			DB, LOG_DB = db, db
			common.SetDatabaseTypes(dialect, dialect)
			initCol()
			tables := []any{&User{}, &Token{}, &UserSession{}, &AuthFlow{}, &ExternalIdentityClaim{}, &PasskeyCredential{}, &TwoFA{}, &TwoFABackupCode{}, &UserOAuthBinding{}, &UserAccessToken{}, &SubscriptionPlan{}, &SubscriptionOrder{}, &UserSubscription{}, &SubscriptionPreConsumeRecord{}, &TopUp{}, &Log{}, &BillingRefund{}, &KnowledgeDocument{}}
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(tables...))
				DB, LOG_DB = oldDB, oldLogDB
				common.SetDatabaseTypes(oldMain, oldLog)
				initCol()
				require.NoError(t, conn.Close())
			})
			versionQuery := "SELECT version()"
			if dialect == common.DatabaseTypeSQLite {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("database version: %s", version)
			// Fresh install, then representative upgrade from the parent schema:
			// only billing_refunds is new; existing account/order schemas are unchanged.
			require.NoError(t, db.AutoMigrate(tables...))
			require.NoError(t, db.Migrator().DropTable(&BillingRefund{}, &KnowledgeDocument{}))
			user := User{Username: "refund-matrix", Quota: 900}
			require.NoError(t, db.Create(&user).Error)
			token := Token{UserId: user.Id, Key: "refund-matrix-key", RemainQuota: 900, UsedQuota: 100}
			require.NoError(t, db.Create(&token).Error)
			require.NoError(t, db.AutoMigrate(tables...))
			require.NoError(t, db.AutoMigrate(tables...))
			assert.Equal(t, 900, getUserQuotaForPaymentGuardTest(t, user.Id))

			t.Run("documents are private and survive upgrade", func(t *testing.T) {
				other := User{Username: "other-matrix", AffCode: "other-aff", Quota: 1}
				require.NoError(t, db.Create(&other).Error)
				content := strings.Repeat("文", 40000)
				doc, err := CreateKnowledgeDocument(user.Id, "报告.txt", content)
				require.NoError(t, err)
				otherDocs, err := ListKnowledgeDocuments(other.Id)
				require.NoError(t, err)
				assert.Empty(t, otherDocs)
				require.Error(t, DeleteKnowledgeDocument(other.Id, doc.ID))
				require.NoError(t, db.AutoMigrate(tables...))
				docs, err := ListKnowledgeDocuments(user.Id)
				require.NoError(t, err)
				require.Len(t, docs, 1)
				assert.Equal(t, content, docs[0].Text)
				require.NoError(t, DeleteKnowledgeDocument(user.Id, doc.ID))
				for range 20 {
					_, err := CreateKnowledgeDocument(other.Id, "item.txt", "content")
					require.NoError(t, err)
				}
				_, err = CreateKnowledgeDocument(other.Id, "overflow.txt", "content")
				require.ErrorIs(t, err, ErrKnowledgeDocumentLimit)
			})

			t.Run("hard delete removes account documents", func(t *testing.T) {
				owner := User{Username: "hard-delete-matrix", AffCode: "hard-delete-aff", AuthVersion: 1}
				require.NoError(t, db.Create(&owner).Error)
				_, err := CreateKnowledgeDocument(owner.Id, "private.txt", "private")
				require.NoError(t, err)
				_, err = HardDeleteUserById(owner.Id)
				require.NoError(t, err)
				var count int64
				require.NoError(t, db.Model(&KnowledgeDocument{}).Where("user_id = ?", owner.Id).Count(&count).Error)
				assert.Zero(t, count)
			})

			t.Run("wallet rollback and recovery", func(t *testing.T) {
				refund := BillingRefund{ID: "wallet-recovery", UserID: user.Id, TokenID: token.Id, WalletQuota: 100, TokenQuota: 100}
				require.NoError(t, EnqueueBillingRefund(&refund))
				// Fail after the wallet update, before the token update. Neither
				// balance may commit; a new worker must recover from the journal.
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:refund_failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "refund_test_tokens" {
						tx.AddError(errors.New("injected token storage failure"))
					}
				}))
				err := ProcessBillingRefund(refund.ID)
				require.NoError(t, db.Callback().Update().Remove("test:refund_failure"))
				require.Error(t, err)
				assert.Equal(t, 900, getUserQuotaForPaymentGuardTest(t, user.Id))
				var stored BillingRefund
				require.NoError(t, db.First(&stored, "id = ?", refund.ID).Error)
				assert.Equal(t, "pending", stored.Status)
				assert.Equal(t, 1, stored.Attempts)
				// No in-memory BillingSession survives this recovery call.
				require.NoError(t, RetryPendingBillingRefunds(100))
				require.NoError(t, EnqueueBillingRefund(&refund))
				require.NoError(t, ProcessBillingRefund(refund.ID))
				assert.Equal(t, 1000, getUserQuotaForPaymentGuardTest(t, user.Id))
				require.NoError(t, db.First(&token, token.Id).Error)
				assert.Equal(t, 1000, token.RemainQuota)
				assert.Zero(t, token.UsedQuota)
			})

			t.Run("subscription refund is atomic and replay safe", func(t *testing.T) {
				sub := UserSubscription{UserId: user.Id, PlanId: 1, AmountTotal: 1000, AmountUsed: 150, Status: "active"}
				require.NoError(t, db.Create(&sub).Error)
				record := SubscriptionPreConsumeRecord{RequestId: "subscription-refund", UserId: user.Id, UserSubscriptionId: sub.Id, PreConsumed: 100, Status: "consumed"}
				require.NoError(t, db.Create(&record).Error)
				refund := BillingRefund{ID: "subscription-recovery", UserID: user.Id, SubscriptionRequestID: record.RequestId, SubscriptionID: sub.Id, SubscriptionExtra: 50}
				require.NoError(t, EnqueueBillingRefund(&refund))
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:record_failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "refund_test_subscription_pre_consume_records" {
						tx.AddError(errors.New("injected record write failure"))
					}
				}))
				err := ProcessBillingRefund(refund.ID)
				require.NoError(t, db.Callback().Update().Remove("test:record_failure"))
				require.Error(t, err)
				require.NoError(t, db.First(&sub, sub.Id).Error)
				assert.EqualValues(t, 150, sub.AmountUsed)
				require.NoError(t, RetryPendingBillingRefunds(100))
				require.NoError(t, ProcessBillingRefund(refund.ID))
				require.NoError(t, RefundSubscriptionPreConsume(record.RequestId))
				require.NoError(t, db.First(&sub, sub.Id).Error)
				assert.Zero(t, sub.AmountUsed)
			})

			t.Run("concurrent workers credit once", func(t *testing.T) {
				if dialect != common.DatabaseTypeSQLite {
					conn.SetMaxOpenConns(4)
				}
				defer conn.SetMaxOpenConns(1)
				before := getUserQuotaForPaymentGuardTest(t, user.Id)
				refund := BillingRefund{ID: "concurrent-refund", UserID: user.Id, WalletQuota: 25}
				require.NoError(t, EnqueueBillingRefund(&refund))
				ready := make(chan struct{})
				results := make(chan error, 2)
				for range 2 {
					go func() { <-ready; results <- ProcessBillingRefund(refund.ID) }()
				}
				close(ready)
				for range 2 {
					require.NoError(t, <-results)
				}
				assert.Equal(t, before+25, getUserQuotaForPaymentGuardTest(t, user.Id))
			})

			t.Run("payment amount and duplicate callbacks", func(t *testing.T) {
				order := createEpayTestOrder(t, user.Id, "matrix-topup", PaymentProviderEpay, common.TopUpStatusPending)
				for _, amount := range []string{"", "0", "-10", "0.01", "10.01", "10.001", "1e1", "NaN", " 10.00", "999999999999999999999"} {
					_, err := RechargeEpay(order.TradeNo, "alipay", amount, "127.0.0.1")
					require.ErrorIs(t, err, ErrPaymentAmountMismatch, amount)
				}
				assert.Equal(t, 1025, getUserQuotaForPaymentGuardTest(t, user.Id))
				assert.Equal(t, common.TopUpStatusPending, GetTopUpByTradeNo(order.TradeNo).Status)
				already, err := RechargeEpay(order.TradeNo, "alipay", "10.00", "127.0.0.1")
				require.NoError(t, err)
				assert.False(t, already)
				balance := getUserQuotaForPaymentGuardTest(t, user.Id)
				already, err = RechargeEpay(order.TradeNo, "alipay", "10", "127.0.0.1")
				require.NoError(t, err)
				assert.True(t, already)
				_, err = RechargeEpay(order.TradeNo, "alipay", "0.01", "127.0.0.1")
				require.ErrorIs(t, err, ErrPaymentAmountMismatch)
				assert.Equal(t, balance, getUserQuotaForPaymentGuardTest(t, user.Id))

				plan := insertSubscriptionPlanForPaymentGuardTest(t, 8001)
				insertSubscriptionOrderForPaymentGuardTest(t, "matrix-subscription", user.Id, plan.Id, PaymentProviderEpay)
				for _, amount := range []string{"", "0.01", "10.00", "9.999"} {
					require.ErrorIs(t, CompleteEpaySubscriptionOrder("matrix-subscription", "", "alipay", amount), ErrPaymentAmountMismatch)
				}
				require.ErrorIs(t, CompleteSubscriptionOrder("matrix-subscription", "", PaymentProviderEpay, "alipay"), ErrPaymentAmountMismatch)
				before := countUserSubscriptionsForPaymentGuardTest(t, user.Id)
				require.NoError(t, CompleteEpaySubscriptionOrder("matrix-subscription", "", "alipay", "9.99"))
				require.NoError(t, CompleteEpaySubscriptionOrder("matrix-subscription", "", "alipay", "9.99"))
				assert.Equal(t, before+1, countUserSubscriptionsForPaymentGuardTest(t, user.Id))
			})
		})
	}
}
