package controller

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func CreateKnowledgeDocument(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 500_000)
	var req struct {
		Name    string `json:"name"`
		Text    string `json:"text"`
		OwnerID int    `json:"owner_id"`
		model.KnowledgeMetadata
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.OwnerID != c.GetInt("id") || req.OwnerID <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	doc, err := model.CreateKnowledgeDocument(c.GetInt("id"), req.Name, req.Text, req.KnowledgeMetadata)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, doc)
}

func UpdateKnowledgeDocumentMetadata(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16_000)
	id, err := strconv.Atoi(c.Param("id"))
	var req struct {
		OwnerID int `json:"owner_id"`
		model.KnowledgeMetadata
	}
	if err != nil || c.ShouldBindJSON(&req) != nil || req.OwnerID <= 0 || req.OwnerID != c.GetInt("id") {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	document, err := model.UpdateKnowledgeMetadata(c.GetInt("id"), id, req.KnowledgeMetadata)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, document)
}

func ListKnowledgeDocuments(c *gin.Context) {
	docs, err := model.ListKnowledgeDocuments(c.GetInt("id"))
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, docs)
}

func DeleteKnowledgeDocument(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || model.DeleteKnowledgeDocument(c.GetInt("id"), id) != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, nil)
}
