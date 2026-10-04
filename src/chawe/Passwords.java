package chawe;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

final class Passwords {
    static final int ITERATIONS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();

    static boolean valid(String password) {
        if (password == null || password.length() < 12 || password.length() > 128) return false;
        boolean lower = false, upper = false, digit = false, symbol = false;
        for (int i = 0; i < password.length(); i++) {
            char c = password.charAt(i);
            if (Character.isISOControl(c)) return false;
            lower |= c >= 'a' && c <= 'z';
            upper |= c >= 'A' && c <= 'Z';
            digit |= c >= '0' && c <= '9';
            symbol |= "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".indexOf(c) >= 0;
        }
        return lower && upper && digit && symbol;
    }

    static Hash create(String password) {
        byte[] salt = new byte[24];
        RANDOM.nextBytes(salt);
        return new Hash(ITERATIONS, Base64.getEncoder().encodeToString(salt),
            Base64.getEncoder().encodeToString(derive(password, salt, ITERATIONS)));
    }

    static boolean matches(String password, Hash hash) {
        byte[] salt = Base64.getDecoder().decode(hash.salt());
        byte[] expected = Base64.getDecoder().decode(hash.value());
        return MessageDigest.isEqual(expected, derive(password, salt, hash.iterations()));
    }

    private static byte[] derive(String password, byte[] salt, int iterations) {
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, 256);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("Password hashing failed", e);
        } finally {
            spec.clearPassword();
        }
    }

    record Hash(int iterations, String salt, String value) { }
}
