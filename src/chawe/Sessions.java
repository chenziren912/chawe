package chawe;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;

final class Sessions {
    static final long LIFETIME = 30L * 24 * 60 * 60;
    private static final long RENEW_INTERVAL = 60 * 60;
    private static final int MAX_SESSIONS = 1000;
    private final SecureRandom random = new SecureRandom();
    private final Path file;
    private Map<String, Session> active = new HashMap<>();

    Sessions(Path directory) throws IOException {
        file = directory.resolve("sessions.tsv");
        if (!Files.exists(file)) return;
        long now = Instant.now().getEpochSecond();
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.equals("# chawe-sessions-v1")) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length != 4 || !fields[0].matches("[0-9a-f]{64}")
                    || !AccountStore.validUsername(fields[1])) throw new IOException("Invalid session file");
            try {
                long expires = Long.parseLong(fields[2]);
                long renewed = Long.parseLong(fields[3]);
                if (expires <= renewed || renewed <= 0) throw new IOException("Invalid session expiry");
                if (expires > now) {
                    Session old = active.putIfAbsent(fields[0], new Session(fields[1], expires, renewed));
                    if (old != null) throw new IOException("Duplicate session");
                }
            } catch (NumberFormatException e) {
                throw new IOException("Invalid session file", e);
            }
        }
        if (active.size() > MAX_SESSIONS) throw new IOException("Too many sessions");
    }

    synchronized String create(String username) throws IOException {
        return replace(null, username);
    }

    Path directory() { return file.getParent(); }

    synchronized String replace(String previousToken, String username) throws IOException {
        if (!AccountStore.validUsername(username)) throw new IllegalArgumentException("Invalid username");
        long now = Instant.now().getEpochSecond();
        Map<String, Session> updated = new HashMap<>(active);
        updated.entrySet().removeIf(entry -> entry.getValue().expires() <= now);
        if (validToken(previousToken)) updated.remove(hash(previousToken));
        if (updated.size() >= MAX_SESSIONS) throw new IllegalStateException("Too many active sessions");
        byte[] bytes = new byte[32];
        String token, tokenHash;
        do {
            random.nextBytes(bytes);
            token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            tokenHash = hash(token);
        } while (updated.containsKey(tokenHash));
        updated.put(tokenHash, new Session(username, now + LIFETIME, now));
        persist(updated);
        active = updated;
        return token;
    }

    synchronized Access access(String token) throws IOException {
        if (!validToken(token)) return null;
        String tokenHash = hash(token);
        Session session = active.get(tokenHash);
        if (session == null) return null;
        long now = Instant.now().getEpochSecond();
        if (session.expires() <= now) return null;
        if (now - session.renewed() < RENEW_INTERVAL) return new Access(session.username(), false);
        Map<String, Session> updated = new HashMap<>(active);
        updated.entrySet().removeIf(entry -> entry.getValue().expires() <= now);
        updated.put(tokenHash, new Session(session.username(), now + LIFETIME, now));
        persist(updated);
        active = updated;
        return new Access(session.username(), true);
    }

    synchronized void remove(String token) throws IOException {
        if (!validToken(token)) return;
        String tokenHash = hash(token);
        if (!active.containsKey(tokenHash)) return;
        Map<String, Session> updated = new HashMap<>(active);
        updated.remove(tokenHash);
        persist(updated);
        active = updated;
    }

    private void persist(Map<String, Session> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-sessions-v1\n");
        for (var entry : updated.entrySet()) {
            Session session = entry.getValue();
            out.append(entry.getKey()).append('\t').append(session.username()).append('\t')
                .append(session.expires()).append('\t').append(session.renewed()).append('\n');
        }
        Path temp = Files.createTempFile(file.getParent(), ".sessions-", ".tmp");
        try {
            Files.setPosixFilePermissions(temp, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(out.toString().getBytes(StandardCharsets.UTF_8));
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    static boolean validToken(String token) {
        return token != null && token.matches("[A-Za-z0-9_-]{43}");
    }

    static String hash(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    record Access(String username, boolean renewed) { }
    private record Session(String username, long expires, long renewed) { }
}
