package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/knowledge"
	"github.com/gin-gonic/gin"
)

// SearchKnowledge is a stateless preview over documents submitted by the user.
// It does not persist files or send them to an upstream model.
func SearchKnowledge(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 3<<20)
	var req struct {
		Query     string               `json:"query"`
		Documents []knowledge.Document `json:"documents"`
		Limit     int                  `json:"limit"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if req.Limit == 0 {
		req.Limit = 5
	}
	result, err := knowledge.Search(req.Query, req.Documents, req.Limit)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, result)
}
