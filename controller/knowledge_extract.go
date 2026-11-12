package controller

import (
	"io"
	"net/http"
	"path/filepath"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/knowledge"
	"github.com/gin-gonic/gin"
)

func ExtractKnowledgeDocument(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 3<<20)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	text, err := knowledge.ExtractText(header.Filename, data)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, gin.H{"name": filepath.Base(header.Filename), "text": text})
}
