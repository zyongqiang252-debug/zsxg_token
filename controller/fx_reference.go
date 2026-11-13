package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func QueryFXReference(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var input service.FXRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		common.ApiErrorT(c, "Check the currency pair, amount and date range (up to 366 days).")
		return
	}
	result, err := service.QueryFXReference(c.Request.Context(), input)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}
