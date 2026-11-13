package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFXReferenceConversionAndPublicationDays(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "base=USD&from=2024-01-01&quotes=CNY&to=2024-01-07", r.URL.RawQuery)
		_, _ = w.Write([]byte(`[{"date":"2023-12-29","base":"USD","quote":"CNY","rate":99},{"date":"2024-01-05","base":"USD","quote":"CNY","rate":7.2},{"date":"2024-01-02","base":"USD","quote":"CNY","rate":7.1}]`))
	}))
	defer server.Close()
	input := FXRequest{Base: " usd ", Quote: "cny", Amount: "0.1", From: "2024-01-01", To: "2024-01-07"}
	result, err := queryFXReference(context.Background(), server.Client(), server.URL, input, time.Now())
	require.NoError(t, err)
	assert.Equal(t, "0.72", result.ConvertedAmount)
	assert.Equal(t, "1.408451", result.ChangePercent)
	assert.Equal(t, "2024-01-02", result.FirstDate)
	assert.Equal(t, "2024-01-05", result.RateDate)
	assert.Equal(t, "7.1", result.MinRate)
	assert.Equal(t, "7.2", result.MaxRate)
	assert.Equal(t, 2, result.ObservationCount)
	assert.Equal(t, FXSourceURL, result.SourceURL)
	assert.NotEmpty(t, result.RetrievedAt)
	input.Amount = "1000000000000"
	result, err = queryFXReference(context.Background(), server.Client(), server.URL, input, time.Now())
	require.NoError(t, err)
	assert.Equal(t, "7200000000000", result.ConvertedAmount)
}

func TestFXReferenceValidationAndUpstreamFailures(t *testing.T) {
	input := FXRequest{Base: "USD", Quote: "JPY", Amount: "0.12345678", From: "2024-01-01", To: "2024-01-07"}
	for _, tc := range []struct {
		name, body, want string
		status           int
	}{
		{"small decimal", `[{"date":"2024-01-02","base":"USD","quote":"JPY","rate":0.00000001}]`, "", 200},
		{"empty", `[]`, "No reference rates", 200},
		{"holiday baseline only", `[{"date":"2023-12-29","base":"USD","quote":"JPY","rate":140}]`, "No reference rates", 200},
		{"wrong direction", `[{"date":"2024-01-02","base":"JPY","quote":"USD","rate":140}]`, "invalid data", 200},
		{"zero", `[{"date":"2024-01-02","base":"USD","quote":"JPY","rate":0}]`, "invalid data", 200},
		{"exponent", `[{"date":"2024-01-02","base":"USD","quote":"JPY","rate":1e99999999}]`, "invalid data", 200},
		{"invalid date", `[{"date":"2024-02-30","base":"USD","quote":"JPY","rate":140}]`, "invalid data", 200},
		{"duplicate date", `[{"date":"2024-01-02","base":"USD","quote":"JPY","rate":140},{"date":"2024-01-02","base":"USD","quote":"JPY","rate":141}]`, "invalid data", 200},
		{"malformed", `{"error":true}`, "invalid data", 200},
		{"oversized", strings.Repeat(" ", (512<<10)+1), "unavailable", 200},
		{"provider failure", `unavailable`, "unavailable", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			result, err := queryFXReference(context.Background(), server.Client(), server.URL, input, time.Now())
			if tc.want != "" {
				require.ErrorContains(t, err, tc.want)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, "0.0000000012345678", result.ConvertedAmount)
			assert.Equal(t, "0", result.ChangePercent)
		})
	}
	for _, tc := range []struct {
		name   string
		change func(*FXRequest)
	}{
		{"same currency", func(r *FXRequest) { r.Quote = r.Base }},
		{"unsupported currency", func(r *FXRequest) { r.Base = "AAA" }},
		{"negative amount", func(r *FXRequest) { r.Amount = "-1" }},
		{"exponent amount", func(r *FXRequest) { r.Amount = "1e99999999" }},
		{"large amount", func(r *FXRequest) { r.Amount = "1000000000001" }},
		{"reversed dates", func(r *FXRequest) { r.To = "2023-12-31" }},
		{"long range", func(r *FXRequest) { r.From = "2022-01-01" }},
		{"future date", func(r *FXRequest) { r.To = "2099-01-01" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := input
			tc.change(&bad)
			_, err := queryFXReference(context.Background(), nil, "", bad, time.Now())
			require.ErrorContains(t, err, "Check the currency pair")
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := queryFXReference(ctx, fxClient, fxEndpoint, input, time.Now())
	require.ErrorContains(t, err, "unavailable")
}

func TestFXReferenceLiveProvider(t *testing.T) {
	if os.Getenv("TEST_FX_LIVE") != "1" {
		t.Skip("TEST_FX_LIVE not configured")
	}
	result, err := QueryFXReference(context.Background(), FXRequest{Base: "USD", Quote: "CNY", Amount: "1000", From: "2024-01-01", To: "2024-01-07"})
	require.NoError(t, err)
	assert.Greater(t, result.ObservationCount, 0)
	assert.Equal(t, "2024-01-05", result.RateDate)
	assert.Equal(t, "ECB via Frankfurter", result.Provider)
	t.Logf("Live USD/CNY: %s on %s; %d observations", result.Rate, result.RateDate, result.ObservationCount)
}
