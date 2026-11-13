package model

import (
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

type knowledgeDocumentV1 struct {
	ID        int
	UserID    int    `gorm:"index;not null"`
	Name      string `gorm:"type:varchar(255);not null"`
	Text      string `gorm:"not null"`
	CreatedAt int64  `gorm:"bigint"`
}

func TestKnowledgeMetadataDatabaseMatrix(t *testing.T) {
	for _, dialect := range []common.DatabaseType{common.DatabaseTypeSQLite, common.DatabaseTypeMySQL, common.DatabaseTypePostgreSQL} {
		t.Run(string(dialect), func(t *testing.T) {
			var driver gorm.Dialector = sqlite.Open(":memory:")
			switch dialect {
			case common.DatabaseTypeMySQL:
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN not configured")
				}
				driver = mysql.Open(dsn)
			case common.DatabaseTypePostgreSQL:
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN not configured")
				}
				driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "knowledge_matrix_"}})
			require.NoError(t, err)
			conn, err := db.DB()
			require.NoError(t, err)
			conn.SetMaxOpenConns(1)
			oldDB := DB
			oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
			DB = db
			common.SetDatabaseTypes(dialect, oldLog)
			initCol()
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&KnowledgeDocument{}, &User{}))
				DB = oldDB
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
			require.NoError(t, db.AutoMigrate(&User{}))
			require.NoError(t, db.Create(&User{Id: 1, Username: "owner", AffCode: "kb-owner"}).Error)
			require.NoError(t, db.Create(&User{Id: 2, Username: "other", AffCode: "kb-other"}).Error)
			for _, upgrade := range []bool{false, true} {
				name := "fresh"
				if upgrade {
					name = "upgrade"
				}
				t.Run(name, func(t *testing.T) {
					require.NoError(t, db.Migrator().DropTable(&KnowledgeDocument{}))
					if upgrade {
						require.NoError(t, db.Table("knowledge_matrix_knowledge_documents").AutoMigrate(&knowledgeDocumentV1{}))
						require.NoError(t, db.Table("knowledge_matrix_knowledge_documents").Create(&knowledgeDocumentV1{UserID: 1, Name: "原始心得.txt", Text: "降息预期与仓位纪律", CreatedAt: 123}).Error)
					}
					require.NoError(t, db.AutoMigrate(&KnowledgeDocument{}))
					require.NoError(t, db.AutoMigrate(&KnowledgeDocument{}))
					if upgrade {
						docs, err := ListKnowledgeDocuments(1)
						require.NoError(t, err)
						require.Len(t, docs, 1)
						require.Equal(t, "降息预期与仓位纪律", docs[0].Text)
						require.EqualValues(t, 123, docs[0].CreatedAt)
						require.Equal(t, "source", docs[0].DocumentType)
						require.Empty(t, docs[0].KnowledgeBase)
					}
					metadata := KnowledgeMetadata{KnowledgeBase: " 汇率研究 ", Author: "张三", DocumentDate: "2026-01-01", Topic: "利率与汇率", Instrument: "USD/CNY", Conditions: "高波动市场"}
					doc, err := CreateKnowledgeDocument(1, "研究.txt", "原始文本😀", metadata)
					require.NoError(t, err)
					require.Equal(t, "汇率研究", doc.KnowledgeBase)
					metadata.Author = "李四"
					metadata.DocumentType = "report"
					updated, err := UpdateKnowledgeMetadata(1, doc.ID, metadata)
					require.NoError(t, err)
					require.Equal(t, "source", updated.DocumentType)
					require.Equal(t, "原始文本😀", updated.Text)
					require.Equal(t, "李四", updated.Author)
					_, err = UpdateKnowledgeMetadata(1, doc.ID, metadata)
					require.NoError(t, err)
					_, err = UpdateKnowledgeMetadata(2, doc.ID, metadata)
					require.Error(t, err)
					other, err := ListKnowledgeDocuments(2)
					require.NoError(t, err)
					require.Empty(t, other)
					cleared, err := UpdateKnowledgeMetadata(1, doc.ID, KnowledgeMetadata{})
					require.NoError(t, err)
					require.Empty(t, cleared.Author)
					require.Empty(t, cleared.KnowledgeBase)
					for _, invalid := range []KnowledgeMetadata{{DocumentDate: "2026-02-30"}, {Author: strings.Repeat("中", 101)}, {KnowledgeBase: "bad\x00name"}, {DocumentType: "unknown"}} {
						_, err = UpdateKnowledgeMetadata(1, doc.ID, invalid)
						require.Error(t, err)
					}
					require.NoError(t, db.AutoMigrate(&KnowledgeDocument{}))
					var stored KnowledgeDocument
					require.NoError(t, db.First(&stored, doc.ID).Error)
					require.Equal(t, "原始文本😀", stored.Text)
				})
			}
		})
	}
}
