package app_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	appConsumer "github.com/cosmos/interchain-security/v3/app/consumer-democracy"
	ibctesting "github.com/cosmos/interchain-security/v3/legacy_ibc_testing/testing"
	icstestingutils "github.com/cosmos/interchain-security/v3/testutil/ibc_testing"
)

func TestDemocracyGovernanceWhitelistingKeys(t *testing.T) {
	chain := ibctesting.NewTestChain(t, ibctesting.NewCoordinator(t, 0),
		icstestingutils.DemocracyConsumerAppIniter, "test")
	paramKeeper := chain.App.(*appConsumer.App).ParamsKeeper
	for paramKey := range appConsumer.LegacyWhitelistedParams {
		ss, ok := paramKeeper.GetSubspace(paramKey.Subspace)
		require.True(t, ok, "Unknown subspace %s", paramKey.Subspace)
		hasKey := ss.Has(chain.GetContext(), []byte(paramKey.Key))
		require.True(t, hasKey, "Invalid key %s for subspace %s", paramKey.Key, paramKey.Subspace)
	}
}
