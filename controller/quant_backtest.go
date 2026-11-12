package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/ashare"
	"github.com/gin-gonic/gin"
)

// RunQuantBacktest evaluates uploaded daily bars without accessing a broker.
func RunQuantBacktest(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
	var req struct {
		Bars   []ashare.Bar  `json:"bars"`
		Config ashare.Config `json:"config"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Bars) == 0 || len(req.Bars) > 5000 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	result, err := ashare.MovingAverage(req.Bars, req.Config)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, result)
}

func ScreenQuantMomentum(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 3<<20)
	var req struct {
		Instruments []ashare.Instrument `json:"instruments"`
		AsOf        string              `json:"as_of"`
		Lookback    int                 `json:"lookback"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	result, err := ashare.ScreenMomentum(req.Instruments, req.AsOf, req.Lookback)
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	common.ApiSuccess(c, result)
}
