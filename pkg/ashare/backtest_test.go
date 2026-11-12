package ashare

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMovingAverageTradesNextDayWithCosts(t *testing.T) {
	bars := []Bar{
		{"2026-01-05", 1000, 1000},
		{"2026-01-06", 1100, 1100},
		{"2026-01-07", 1200, 900},
		{"2026-01-08", 800, 800},
	}
	result, err := MovingAverage(bars, Config{InitialCashFen: 300000, Window: 2, CommissionBPS: 10, MinimumFeeFen: 500, SellTaxBPS: 10})
	require.NoError(t, err)
	require.Len(t, result.Trades, 2)
	assert.Equal(t, Trade{"2026-01-07", "buy", 200, 1200, 500}, result.Trades[0])
	assert.Equal(t, Trade{"2026-01-08", "sell", 200, 800, 660}, result.Trades[1])
	assert.Equal(t, int64(218840), result.Equity[len(result.Equity)-1].EquityFen)
}

func TestMovingAverageRejectsInvalidInput(t *testing.T) {
	c := Config{InitialCashFen: 100000, Window: 2}
	for _, bars := range [][]Bar{
		{{"2026-01-05", 100, 100}, {"2026-01-05", 100, 100}},
		{{"2026-02-30", 100, 100}},
		{{"2026-01-05", -1, 100}},
	} {
		_, err := MovingAverage(bars, c)
		assert.Error(t, err)
	}
}
