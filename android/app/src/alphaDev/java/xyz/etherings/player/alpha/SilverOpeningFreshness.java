package xyz.etherings.player.alpha;

final class SilverOpeningFreshness {
    static void require(String trustedGenesis, String rpcGenesis, String messageBlockhash,
            String checkedBlockhash, long lastValidBlockHeight, long currentBlockHeight,
            boolean blockhashValid) {
        if (trustedGenesis == null || trustedGenesis.isEmpty() ||
                !trustedGenesis.equals(rpcGenesis))
            throw new IllegalArgumentException("Silver opening cluster mismatch");
        if (messageBlockhash == null || messageBlockhash.isEmpty() ||
                !messageBlockhash.equals(checkedBlockhash))
            throw new IllegalArgumentException("Silver opening blockhash mismatch");
        if (lastValidBlockHeight <= 0 || currentBlockHeight < 0 ||
                currentBlockHeight > lastValidBlockHeight || !blockhashValid)
            throw new IllegalArgumentException("Silver opening blockhash expired");
    }
}
