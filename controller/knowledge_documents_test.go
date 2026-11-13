package controller

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestCreateKnowledgeDocumentRejectsChangedAccount(t *testing.T) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("id", 2)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/knowledge/documents", strings.NewReader(`{"owner_id":1,"name":"private.txt","text":"private"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	CreateKnowledgeDocument(c)
	assert.Contains(t, w.Body.String(), `"success":false`)
}

func TestKnowledgeMetadataEndpointsPreserveSourceText(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	conn.SetMaxOpenConns(1)
	oldDB := model.DB
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	model.DB = db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, oldLog)
	t.Cleanup(func() { model.DB = oldDB; common.SetDatabaseTypes(oldMain, oldLog); require.NoError(t, conn.Close()) })
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.KnowledgeDocument{}))
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "metadata-owner", AffCode: "metadata-owner"}).Error)
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("id", 1) })
	router.POST("/documents", CreateKnowledgeDocument)
	router.PUT("/documents/:id/metadata", UpdateKnowledgeDocumentMetadata)
	create := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/documents", strings.NewReader(`{"owner_id":1,"name":"心得.txt","text":"保持原文😀","knowledge_base":" 汇率 ","author":"作者甲","document_date":"2026-01-01","topic":"利差","conditions":"高波动"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(create, req)
	var response struct {
		Success bool                    `json:"success"`
		Data    model.KnowledgeDocument `json:"data"`
	}
	require.NoError(t, common.Unmarshal(create.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.Equal(t, "汇率", response.Data.KnowledgeBase)
	require.Equal(t, "作者甲", response.Data.Author)
	id := response.Data.ID
	update := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/documents/"+strconv.Itoa(id)+"/metadata", strings.NewReader(`{"owner_id":1,"knowledge_base":"宏观","author":"作者乙","document_date":"2026-02-01","topic":"利率","text":"must not overwrite"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(update, req)
	require.NoError(t, common.Unmarshal(update.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.Equal(t, id, response.Data.ID)
	require.Equal(t, "保持原文😀", response.Data.Text)
	require.Equal(t, "作者乙", response.Data.Author)
	require.Equal(t, "宏观", response.Data.KnowledgeBase)
}

func TestUpdateKnowledgeMetadataRejectsChangedAccount(t *testing.T) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("id", 2)
	c.Params = gin.Params{{Key: "id", Value: "1"}}
	c.Request = httptest.NewRequest(http.MethodPut, "/api/knowledge/documents/1/metadata", strings.NewReader(`{"owner_id":1,"author":"other"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	UpdateKnowledgeDocumentMetadata(c)
	assert.Contains(t, w.Body.String(), `"success":false`)
}
