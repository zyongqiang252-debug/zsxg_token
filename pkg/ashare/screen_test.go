package ashare

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestScreenMomentumUsesOnlyCurrentAndPastData(t *testing.T) {
	instruments := []Instrument{
		{"A", []Bar{{Date: "2026-01-05", Close: 1000}, {Date: "2026-01-06", Close: 1100}, {Date: "2026-01-07", Close: 100}}},
		{"B", []Bar{{Date: "2026-01-05", Close: 1000}, {Date: "2026-01-06", Close: 1050}}},
		{"C", []Bar{{Date: "2026-01-05", Close: 1000}}},
	}
	result, err := ScreenMomentum(instruments, "2026-01-06", 1)
	require.NoError(t, err)
	require.Len(t, result.Items, 2)
	assert.Equal(t, "A", result.Items[0].Symbol)
	assert.EqualValues(t, 1000, result.Items[0].MomentumBPS)
	assert.Equal(t, []string{"C"}, result.Excluded)
}

func TestScreenMomentumRejectsDuplicateAndUnorderedData(t *testing.T) {
	_, err := ScreenMomentum([]Instrument{{Symbol: "A"}, {Symbol: "A"}}, "2026-01-06", 1)
	assert.Error(t, err)
	_, err = ScreenMomentum([]Instrument{{Symbol: "A", Bars: []Bar{{Date: "2026-01-06", Close: 100}, {Date: "2026-01-05", Close: 100}}}}, "2026-01-06", 1)
	assert.Error(t, err)
}
