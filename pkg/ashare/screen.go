package ashare

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type Instrument struct {
	Symbol string `json:"symbol"`
	Bars   []Bar  `json:"bars"`
}

type ScreeningResult struct {
	Items    []ScreeningItem `json:"items"`
	Excluded []string        `json:"excluded"`
}

type ScreeningItem struct {
	Symbol      string `json:"symbol"`
	AsOf        string `json:"as_of"`
	CloseFen    int64  `json:"close_fen"`
	MomentumBPS int64  `json:"momentum_bps"`
}

// ScreenMomentum compares local closing prices over a fixed number of trading
// sessions. It never uses data after asOf and excludes stale/incomplete series.
// Results are descriptive statistics, not investment recommendations.
func ScreenMomentum(instruments []Instrument, asOf string, lookback int) (ScreeningResult, error) {
	out := ScreeningResult{Items: []ScreeningItem{}, Excluded: []string{}}
	date, err := time.Parse("2006-01-02", asOf)
	if err != nil || date.Format("2006-01-02") != asOf || lookback < 1 || lookback > 250 || len(instruments) < 1 || len(instruments) > 100 {
		return out, errors.New("invalid screening request")
	}
	seen := make(map[string]struct{}, len(instruments))
	total := 0
	for _, item := range instruments {
		symbol := strings.TrimSpace(item.Symbol)
		if symbol == "" || len(symbol) > 32 || symbol != item.Symbol {
			return out, errors.New("invalid symbol")
		}
		if _, exists := seen[symbol]; exists {
			return out, errors.New("duplicate symbol")
		}
		seen[symbol] = struct{}{}
		total += len(item.Bars)
		if total > 50_000 {
			return out, errors.New("too many price bars")
		}
		last := -1
		for i, bar := range item.Bars {
			day, parseErr := time.Parse("2006-01-02", bar.Date)
			if parseErr != nil || day.Format("2006-01-02") != bar.Date || i > 0 && bar.Date <= item.Bars[i-1].Date || bar.Close <= 0 || bar.Close > 1_000_000 {
				return out, errors.New("invalid daily bars")
			}
			if bar.Date <= asOf {
				last = i
			}
		}
		if last < lookback || item.Bars[last].Date != asOf {
			out.Excluded = append(out.Excluded, symbol)
			continue
		}
		old, current := item.Bars[last-lookback].Close, item.Bars[last].Close
		out.Items = append(out.Items, ScreeningItem{symbol, asOf, current, (current - old) * 10_000 / old})
	}
	sort.Slice(out.Items, func(i, j int) bool {
		if out.Items[i].MomentumBPS == out.Items[j].MomentumBPS {
			return out.Items[i].Symbol < out.Items[j].Symbol
		}
		return out.Items[i].MomentumBPS > out.Items[j].MomentumBPS
	})
	return out, nil
}
