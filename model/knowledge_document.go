package model

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var ErrKnowledgeDocumentLimit = errors.New("document limit reached")

type KnowledgeMetadata struct {
	KnowledgeBase string `json:"knowledge_base" gorm:"type:varchar(100);not null;default:''"`
	Author        string `json:"author" gorm:"type:varchar(100);not null;default:''"`
	DocumentDate  string `json:"document_date" gorm:"type:varchar(10);not null;default:''"`
	Topic         string `json:"topic" gorm:"type:varchar(200);not null;default:''"`
	Instrument    string `json:"instrument" gorm:"type:varchar(100);not null;default:''"`
	Conditions    string `json:"conditions" gorm:"type:varchar(2000);not null;default:''"`
	DocumentType  string `json:"document_type" gorm:"type:varchar(16);not null;default:source"`
}

func (metadata *KnowledgeMetadata) Normalize() error {
	fields := []struct {
		value *string
		limit int
	}{
		{&metadata.KnowledgeBase, 100}, {&metadata.Author, 100}, {&metadata.DocumentDate, 10},
		{&metadata.Topic, 200}, {&metadata.Instrument, 100}, {&metadata.Conditions, 2000},
	}
	for _, field := range fields {
		*field.value = strings.TrimSpace(*field.value)
		if !utf8.ValidString(*field.value) || strings.ContainsRune(*field.value, 0) || utf8.RuneCountInString(*field.value) > field.limit {
			return errors.New("invalid document metadata")
		}
	}
	if metadata.DocumentDate != "" {
		if _, err := time.Parse("2006-01-02", metadata.DocumentDate); err != nil {
			return errors.New("invalid document date")
		}
	}
	if metadata.KnowledgeBase == "*" {
		return errors.New("invalid knowledge base name")
	}
	if metadata.DocumentType == "" {
		metadata.DocumentType = "source"
	}
	if metadata.DocumentType != "source" && metadata.DocumentType != "report" {
		return errors.New("invalid document type")
	}
	return nil
}

type KnowledgeDocument struct {
	ID                int    `json:"id"`
	UserID            int    `json:"-" gorm:"index;not null"`
	Name              string `json:"name" gorm:"type:varchar(255);not null"`
	Text              string `json:"text" gorm:"not null"`
	CreatedAt         int64  `json:"created_at" gorm:"bigint"`
	KnowledgeMetadata `gorm:"embedded"`
}

// CreateKnowledgeDocument locks the owner row so concurrent requests cannot
// bypass the per-user document limit on row-locking databases.
func CreateKnowledgeDocument(userID int, name, text string, details ...KnowledgeMetadata) (*KnowledgeDocument, error) {
	name = strings.TrimSpace(name)
	if userID <= 0 || name == "" || !utf8.ValidString(name) || strings.ContainsRune(name, 0) || utf8.RuneCountInString(name) > 255 || strings.TrimSpace(text) == "" ||
		!utf8.ValidString(text) || strings.ContainsRune(text, 0) || utf8.RuneCountInString(text) > 100_000 {
		return nil, errors.New("invalid document")
	}
	doc := &KnowledgeDocument{UserID: userID, Name: name, Text: text, CreatedAt: common.GetTimestamp()}
	if len(details) > 1 {
		return nil, errors.New("invalid document metadata")
	}
	if len(details) == 1 {
		doc.KnowledgeMetadata = details[0]
	}
	if err := doc.KnowledgeMetadata.Normalize(); err != nil {
		return nil, err
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		// SQLite must acquire its write lock before reading the quota owner and
		// document count; upgrading a read snapshot can fail during relay settlement.
		if common.UsingMainDatabase(common.DatabaseTypeSQLite) {
			if err := tx.Model(&User{}).Where("id = ?", userID).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
				return err
			}
		}
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

// Metadata edits preserve the source text and its citation offsets.
func UpdateKnowledgeMetadata(userID, id int, metadata KnowledgeMetadata) (*KnowledgeDocument, error) {
	if userID <= 0 || id <= 0 {
		return nil, errors.New("invalid document")
	}
	if err := metadata.Normalize(); err != nil {
		return nil, err
	}
	var document KnowledgeDocument
	err := DB.Transaction(func(tx *gorm.DB) error {
		if common.UsingMainDatabase(common.DatabaseTypeSQLite) {
			if err := tx.Model(&KnowledgeDocument{}).Where("user_id = ? AND id = ?", userID, id).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
				return err
			}
		}
		if err := lockForUpdate(tx).Where("user_id = ? AND id = ?", userID, id).First(&document).Error; err != nil {
			return err
		}
		if err := tx.Model(&KnowledgeDocument{}).Where("user_id = ? AND id = ?", userID, id).Updates(map[string]any{
			"knowledge_base": metadata.KnowledgeBase, "author": metadata.Author, "document_date": metadata.DocumentDate,
			"topic": metadata.Topic, "instrument": metadata.Instrument, "conditions": metadata.Conditions,
		}).Error; err != nil {
			return err
		}
		metadata.DocumentType = document.DocumentType
		document.KnowledgeMetadata = metadata
		return nil
	})
	return &document, err
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
