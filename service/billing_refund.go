package service

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

func StartBillingRefundWorker() {
	if common.BatchUpdateEnabled {
		common.SysError(common.LogText("durable billing refunds disabled: BATCH_UPDATE_ENABLED must be false"))
		return
	}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			if err := model.RetryPendingBillingRefunds(100); err != nil {
				common.SysError(common.LogText("billing refund retry failed: %s", err.Error()))
			}
			<-ticker.C
		}
	}()
}
