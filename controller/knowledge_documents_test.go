package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
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
