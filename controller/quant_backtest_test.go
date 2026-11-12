package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestRunQuantBacktest(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"valid daily bars", `{"bars":[{"date":"2026-01-05","open_fen":1000,"close_fen":1000}],"config":{"initial_cash_fen":100000,"window":2}}`, `"success":true`},
		{"invalid date", `{"bars":[{"date":"bad","open_fen":1000,"close_fen":1000}],"config":{"initial_cash_fen":100000,"window":2}}`, `"success":false`},
		{"empty bars", `{"bars":[],"config":{"initial_cash_fen":100000,"window":2}}`, `"success":false`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(response)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/quant/backtest", strings.NewReader(tc.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			RunQuantBacktest(ctx)
			assert.Contains(t, response.Body.String(), tc.want)
		})
	}
}

func TestScreenQuantMomentum(t *testing.T) {
	body := `{"as_of":"2026-01-06","lookback":1,"instruments":[{"symbol":"600000.SH","bars":[{"date":"2026-01-05","close_fen":1000},{"date":"2026-01-06","close_fen":1100}]}]}`
	response := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(response)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/quant/screen", strings.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ScreenQuantMomentum(ctx)
	assert.Contains(t, response.Body.String(), `"success":true`)
	assert.Contains(t, response.Body.String(), `"momentum_bps":1000`)
}
