// Package ashare provides deterministic offline strategy simulation.
// It does not connect to a broker or guarantee real-world execution.
package ashare

import (
	"errors"
	"fmt"
	"time"
)

// Bar uses integer fen per share, avoiding floating-point settlement errors.
type Bar struct {
	Date  string `json:"date"`
	Open  int64  `json:"open_fen"`
	Close int64  `json:"close_fen"`
}

// Config defines explicit assumptions rather than hard-coding tax policies.
type Config struct {
	InitialCashFen int64 `json:"initial_cash_fen"`
	Window         int   `json:"window"`
	CommissionBPS  int64 `json:"commission_bps"`
	MinimumFeeFen  int64 `json:"minimum_fee_fen"`
	SellTaxBPS     int64 `json:"sell_tax_bps"`
	SlippageBPS    int64 `json:"slippage_bps"`
}

type Trade struct {
	Date     string `json:"date"`
	Side     string `json:"side"`
	Shares   int64  `json:"shares"`
	PriceFen int64  `json:"price_fen"`
	FeeFen   int64  `json:"fee_fen"`
}

type Point struct {
	Date      string `json:"date"`
	CashFen   int64  `json:"cash_fen"`
	Shares    int64  `json:"shares"`
	EquityFen int64  `json:"equity_fen"`
}

type Result struct {
	Trades []Trade `json:"trades"`
	Equity []Point `json:"equity"`
}

func fee(amount, bps, minimum int64) int64 {
	if amount == 0 {
		return 0
	}
	return max((amount*bps+5000)/10000, minimum)
}

// MovingAverage executes yesterday's close signal at today's open. Purchases
// are in 100-share lots; sales cannot occur on the purchase day. The result is
// a research approximation: it does not model suspensions, price limits,
// liquidity, dividends, split adjustments, or order-book partial fills.
func MovingAverage(bars []Bar, c Config) (Result, error) {
	result := Result{Trades: []Trade{}, Equity: []Point{}}
	if c.InitialCashFen <= 0 || c.InitialCashFen > 1_000_000_000_000 || c.Window < 2 || c.Window > 250 ||
		c.CommissionBPS < 0 || c.CommissionBPS > 1000 || c.SellTaxBPS < 0 || c.SellTaxBPS > 1000 ||
		c.SlippageBPS < 0 || c.SlippageBPS > 1000 || c.MinimumFeeFen < 0 || c.MinimumFeeFen > 1_000_000 {
		return result, errors.New("invalid backtest configuration")
	}
	if len(bars) > 100_000 {
		return result, errors.New("too many daily bars")
	}
	for i, bar := range bars {
		date, err := time.Parse("2006-01-02", bar.Date)
		if err != nil || date.Format("2006-01-02") != bar.Date || i > 0 && bar.Date <= bars[i-1].Date {
			return result, fmt.Errorf("invalid or unordered date at row %d", i+1)
		}
		if bar.Open <= 0 || bar.Open > 1_000_000 || bar.Close <= 0 || bar.Close > 1_000_000 {
			return result, fmt.Errorf("invalid price at row %d", i+1)
		}
	}
	cash, shares, sum := c.InitialCashFen, int64(0), int64(0)
	for i, bar := range bars {
		// Only the previous day's completed data may affect this open.
		if i >= c.Window {
			previous := bars[i-1].Close
			if previous*int64(c.Window) > sum && shares == 0 {
				price := (bar.Open*(10000+c.SlippageBPS) + 9999) / 10000
				lots := cash / (price * 100)
				for lots > 0 {
					amount := lots * 100 * price
					cost := amount + fee(amount, c.CommissionBPS, c.MinimumFeeFen)
					if cost <= cash {
						shares = lots * 100
						cash -= cost
						result.Trades = append(result.Trades, Trade{bar.Date, "buy", shares, price, cost - amount})
						break
					}
					lots--
				}
			} else if previous*int64(c.Window) < sum && shares > 0 {
				price := max(int64(1), bar.Open*(10000-c.SlippageBPS)/10000)
				if shares > 1_000_000_000_000/price {
					return Result{}, errors.New("backtest value exceeds supported limit")
				}
				amount := shares * price
				charges := fee(amount, c.CommissionBPS, c.MinimumFeeFen) + fee(amount, c.SellTaxBPS, 0)
				if charges <= amount {
					cash += amount - charges
					result.Trades = append(result.Trades, Trade{bar.Date, "sell", shares, price, charges})
					shares = 0
				}
			}
		}
		if cash > 1_000_000_000_000 || shares > (1_000_000_000_000-cash)/bar.Close {
			return Result{}, errors.New("backtest value exceeds supported limit")
		}
		result.Equity = append(result.Equity, Point{bar.Date, cash, shares, cash + shares*bar.Close})
		sum += bar.Close
		if i >= c.Window {
			sum -= bars[i-c.Window].Close
		}
	}
	return result, nil
}
