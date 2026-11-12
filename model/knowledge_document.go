package model

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var ErrKnowledgeDocumentLimit = errors.New("document limit reached")

type KnowledgeDocument struct {
	ID        int    `json:"id"`
	UserID    int    `json:"-" gorm:"index;not null"`
	Name      string `json:"name" gorm:"type:varchar(255);not null"`
	Text      string `json:"text" gorm:"not null"`
	CreatedAt int64  `json:"created_at" gorm:"bigint"`
}

// CreateKnowledgeDocument locks the owner row so concurrent requests cannot
// bypass the per-user document limit on row-locking databases.
func CreateKnowledgeDocument(userID int, name, text string) (*KnowledgeDocument, error) {
	name = strings.TrimSpace(name)
	if userID <= 0 || name == "" || !utf8.ValidString(name) || strings.ContainsRune(name, 0) || utf8.RuneCountInString(name) > 255 || strings.TrimSpace(text) == "" ||
		!utf8.ValidString(text) || strings.ContainsRune(text, 0) || utf8.RuneCountInString(text) > 100_000 {
		return nil, errors.New("invalid document")
	}
	doc := &KnowledgeDocument{UserID: userID, Name: name, Text: text, CreatedAt: common.GetTimestamp()}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var owner User
		if err := lockForUpdate(tx).Select("id").Where("id = ?", userID).First(&owner).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&KnowledgeDocument{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count >= 20 {
			return ErrKnowledgeDocumentLimit
		}
		return tx.Create(doc).Error
	})
	return doc, err
}

func ListKnowledgeDocuments(userID int) ([]KnowledgeDocument, error) {
	if userID <= 0 {
		return nil, errors.New("invalid user")
	}
	var docs []KnowledgeDocument
	err := DB.Where("user_id = ?", userID).Order("id DESC").Limit(20).Find(&docs).Error
	return docs, err
}

func DeleteKnowledgeDocument(userID, id int) error {
	if userID <= 0 || id <= 0 {
		return errors.New("invalid document")
	}
	result := DB.Where("user_id = ? AND id = ?", userID, id).Delete(&KnowledgeDocument{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
