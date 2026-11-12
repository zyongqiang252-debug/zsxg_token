package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKnowledgeAssistantPreparesBilledChat(t *testing.T) {
	router := gin.New()
	router.POST("/agent", PrepareKnowledgeAssistant(), func(c *gin.Context) {
		assert.Equal(t, "/v1/chat/completions", c.Request.URL.Path)
		var payload struct {
			Model     string `json:"model"`
			MaxTokens int    `json:"max_tokens"`
			Messages  []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		require.NoError(t, common.UnmarshalBodyReusable(c, &payload))
		assert.Equal(t, "model-a", payload.Model)
		assert.Equal(t, 32, payload.MaxTokens)
		require.Len(t, payload.Messages, 2)
		assert.Equal(t, "system", payload.Messages[0].Role)
		assert.Contains(t, payload.Messages[0].Content, "untrusted data")
		assert.Contains(t, payload.Messages[1].Content, "营业收入增长")
		assert.Contains(t, payload.Messages[1].Content, "backtest-result")
		assert.NotContains(t, payload.Messages[1].Content, "irrelevant-document")
		c.Status(http.StatusNoContent)
	})
	body := `{"model":"model-a","question":"营业收入如何","max_tokens":32,"context":"backtest-result","documents":[{"id":"report","text":"营业收入增长"},{"id":"other","text":"irrelevant-document"}]}`
	req := httptest.NewRequest(http.MethodPost, "/agent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestKnowledgeAssistantRejectsUnboundedOutput(t *testing.T) {
	router := gin.New()
	router.POST("/agent", PrepareKnowledgeAssistant(), func(c *gin.Context) { t.Fatal("must not reach model") })
	for _, body := range []string{`{"model":"m","question":"q","max_tokens":999999}`, `{"model":"m","question":"q","max_tokens":1,"reasoning_effort":"invalid"}`, `{"model":"m","question":"q","max_tokens":1,"context":"` + strings.Repeat("x", 20001) + `"}`} {
		req := httptest.NewRequest(http.MethodPost, "/agent", strings.NewReader(body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	}
}
