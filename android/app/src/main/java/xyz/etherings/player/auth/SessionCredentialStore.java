package xyz.etherings.player.auth;

import java.security.GeneralSecurityException;

public interface SessionCredentialStore {
    SessionCredentials getCredentials() throws GeneralSecurityException;

    void saveCredentials(SessionCredentials credentials) throws GeneralSecurityException;

    void clear();

    default boolean replaceIfCurrent(SessionCredentials expected, SessionCredentials replacement)
            throws GeneralSecurityException {
        if (!sameSession(getCredentials(), expected)) return false;
        saveCredentials(replacement);
        return true;
    }

    default boolean clearIfCurrent(SessionCredentials expected) throws GeneralSecurityException {
        if (!sameSession(getCredentials(), expected)) return false;
        clear();
        return true;
    }

    static boolean sameSession(SessionCredentials current, SessionCredentials expected) {
        return current != null && expected != null
                && current.ownerId().equals(expected.ownerId())
                && current.installationId().equals(expected.installationId())
                && current.accessToken().equals(expected.accessToken())
                && current.refreshToken().equals(expected.refreshToken());
    }
}
