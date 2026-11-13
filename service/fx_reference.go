package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
)

const FXSourceURL = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"

const fxEndpoint = "https://api.frankfurter.dev/v2/providers/ecb/rates"

var fxClient = &http.Client{
	Timeout:       12 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

var fxDecimal = regexp.MustCompile(`^\d{1,13}(\.\d{1,12})?$`)
var fxAmount = regexp.MustCompile(`^\d{1,13}(\.\d{1,8})?$`)

// FXRequest uses decimal strings so conversion never passes through binary floats.
type FXRequest struct {
	Base   string `json:"base"`
	Quote  string `json:"quote"`
	Amount string `json:"amount"`
	From   string `json:"from"`
	To     string `json:"to"`
}

type FXObservation struct {
	Date string `json:"date"`
	Rate string `json:"rate"`
}

type fxProviderRow struct {
	Date  string      `json:"date"`
	Base  string      `json:"base"`
	Quote string      `json:"quote"`
	Rate  json.Number `json:"rate"`
}

type FXResult struct {
	FXRequest
	Rate             string          `json:"rate"`
	RateDate         string          `json:"rate_date"`
	ConvertedAmount  string          `json:"converted_amount"`
	FirstDate        string          `json:"first_date"`
	ChangePercent    string          `json:"change_percent"`
	MinRate          string          `json:"min_rate"`
	MaxRate          string          `json:"max_rate"`
	ObservationCount int             `json:"observation_count"`
	Observations     []FXObservation `json:"observations"`
	Provider         string          `json:"provider"`
	SourceURL        string          `json:"source_url"`
	APIURL           string          `json:"api_url"`
	RetrievedAt      string          `json:"retrieved_at"`
}

func QueryFXReference(ctx context.Context, input FXRequest) (*FXResult, error) {
	return queryFXReference(ctx, fxClient, fxEndpoint, input, time.Now())
}

func queryFXReference(ctx context.Context, client *http.Client, endpoint string, input FXRequest, now time.Time) (*FXResult, error) {
	input.Base = strings.ToUpper(strings.TrimSpace(input.Base))
	input.Quote = strings.ToUpper(strings.TrimSpace(input.Quote))
	input.Amount = strings.TrimSpace(input.Amount)
	currencies := strings.Fields("EUR USD CNY JPY GBP HKD SGD AUD CAD CHF NZD KRW INR THB MYR IDR PHP SEK NOK DKK")
	from, fromErr := time.Parse(time.DateOnly, input.From)
	to, toErr := time.Parse(time.DateOnly, input.To)
	if !slices.Contains(currencies, input.Base) || !slices.Contains(currencies, input.Quote) || input.Base == input.Quote ||
		fromErr != nil || toErr != nil || input.From < "1999-01-04" || from.After(to) || to.Sub(from) > 365*24*time.Hour ||
		input.To > now.UTC().Add(14*time.Hour).Format(time.DateOnly) || !fxAmount.MatchString(input.Amount) {
		return nil, common.NewMessage("Check the currency pair, amount and date range (up to 366 days).")
	}
	amount, _ := decimal.NewFromString(input.Amount)
	if amount.GreaterThan(decimal.NewFromInt(1_000_000_000_000)) {
		return nil, common.NewMessage("Check the currency pair, amount and date range (up to 366 days).")
	}
	query := url.Values{"base": {input.Base}, "quotes": {input.Quote}, "from": {input.From}, "to": {input.To}}
	apiURL := endpoint + "?" + query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, common.NewMessage("Reference rate service is unavailable. Try again later.")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, common.NewMessage("Reference rate service is unavailable. Try again later.")
	}
	defer resp.Body.Close()
	const limit = 512 << 10
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || resp.StatusCode != http.StatusOK || len(body) > limit {
		return nil, common.NewMessage("Reference rate service is unavailable. Try again later.")
	}
	var rows []fxProviderRow
	if err := common.Unmarshal(body, &rows); err != nil || len(rows) > 367 {
		return nil, common.NewMessage("Reference rate service returned invalid data.")
	}
	slices.SortFunc(rows, func(a, b fxProviderRow) int { return strings.Compare(a.Date, b.Date) })
	result := &FXResult{FXRequest: input, Provider: "ECB via Frankfurter", SourceURL: FXSourceURL, APIURL: apiURL, RetrievedAt: time.Now().UTC().Format(time.RFC3339)}
	var first, last, low, high decimal.Decimal
	for _, row := range rows {
		_, dateErr := time.Parse(time.DateOnly, row.Date)
		if dateErr != nil || row.Base != input.Base || row.Quote != input.Quote || !fxDecimal.MatchString(row.Rate.String()) {
			return nil, common.NewMessage("Reference rate service returned invalid data.")
		}
		rate, _ := decimal.NewFromString(row.Rate.String())
		if !rate.IsPositive() || rate.GreaterThan(decimal.NewFromInt(1_000_000_000_000)) {
			return nil, common.NewMessage("Reference rate service returned invalid data.")
		}
		// The provider can include the preceding business day as a baseline.
		// Only actual observations inside the requested period enter statistics.
		if row.Date < input.From || row.Date > input.To {
			continue
		}
		if len(result.Observations) > 0 && result.RateDate == row.Date {
			return nil, common.NewMessage("Reference rate service returned invalid data.")
		}
		if len(result.Observations) == 0 {
			first, low, high = rate, rate, rate
			result.FirstDate = row.Date
		}
		last = rate
		low, high = decimal.Min(low, rate), decimal.Max(high, rate)
		result.RateDate = row.Date
		result.Observations = append(result.Observations, FXObservation{Date: row.Date, Rate: rate.String()})
	}
	if len(result.Observations) == 0 {
		return nil, common.NewMessage("No reference rates in this period. Try a wider date range.")
	}
	result.Rate = last.String()
	result.ConvertedAmount = amount.Mul(last).String()
	result.ChangePercent = last.Sub(first).Mul(decimal.NewFromInt(100)).DivRound(first, 6).String()
	result.MinRate, result.MaxRate = low.String(), high.String()
	result.ObservationCount = len(result.Observations)
	return result, nil
}
