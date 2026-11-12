package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestSearchKnowledgeReturnsSource(t *testing.T) {
	body := `{"query":"营业收入","documents":[{"id":"report","name":"report.txt","text":"营业收入保持增长"}]}`
	response := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(response)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/knowledge/search", strings.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	SearchKnowledge(ctx)
	assert.Contains(t, response.Body.String(), `"success":true`)
	assert.Contains(t, response.Body.String(), `"document_id":"report"`)
}
