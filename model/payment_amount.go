package model

import (
	"errors"
	"math"
	"regexp"
	"strconv"

	"github.com/shopspring/decimal"
)

var ErrPaymentAmountMismatch = errors.New("payment amount does not match order")

var epayMoneyPattern = regexp.MustCompile(`^[0-9]{1,16}(\.[0-9]{1,2})?$`)

// Epay sends major currency units with at most two decimal places. Compare
// decimals against the exact two-decimal amount sent by Purchase, never floats.
// Epay's callback has no currency field; the configured gateway must use the
// same settlement currency as order creation.
func validateEpayAmount(expected float64, actual string) error {
	if math.IsNaN(expected) || math.IsInf(expected, 0) || expected <= 0 || !epayMoneyPattern.MatchString(actual) {
		return ErrPaymentAmountMismatch
	}
	paid, err := decimal.NewFromString(actual)
	if err != nil || !paid.IsPositive() {
		return ErrPaymentAmountMismatch
	}
	want, err := decimal.NewFromString(strconv.FormatFloat(expected, 'f', 2, 64))
	if err != nil || !paid.Equal(want) {
		return ErrPaymentAmountMismatch
	}
	return nil
}
