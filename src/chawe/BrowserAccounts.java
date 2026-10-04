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
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

/** A browser credential authorizes only accounts authenticated on that browser. */
final class BrowserAccounts {
    static final int MAX_ACCOUNTS = 5;
    private static final int MAX_BROWSERS = 1000;
    private static final long RENEW_INTERVAL = 60 * 60;
    private final SecureRandom random = new SecureRandom();
    private final Path file;
    private Map<String, Browser> browsers = new HashMap<>();

    BrowserAccounts(Path directory) throws IOException {
        file = directory.resolve("browser-accounts-v1.tsv");
        if (!Files.exists(file)) return;
        long now = Instant.now().getEpochSecond();
        boolean trimmed = false;
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.equals("# chawe-browser-accounts-v1")) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length != 5 || !fields[0].matches("[0-9a-f]{64}")) throw new IOException("Invalid browser accounts file");
            try {
                long expires = Long.parseLong(fields[1]), renewed = Long.parseLong(fields[2]);
                List<String> users = List.of(fields[4].split(",", -1));
                if (expires <= renewed || renewed <= 0 || users.isEmpty() || users.size() > 200
                        || users.stream().anyMatch(user -> !AccountStore.validUsername(user))
                        || new HashSet<>(users).size() != users.size() || !users.contains(fields[3]))
                    throw new IOException("Invalid browser account membership");
                if (users.size() > MAX_ACCOUNTS) {
                    List<String> kept = new ArrayList<>(users);
                    while (kept.size() > MAX_ACCOUNTS) kept.remove(kept.get(0).equals(fields[3]) ? 1 : 0);
                    users = List.copyOf(kept); trimmed = true;
                }
                if (expires > now && browsers.putIfAbsent(fields[0], new Browser(users, fields[3], expires, renewed)) != null)
                    throw new IOException("Duplicate browser credential");
            } catch (NumberFormatException e) {
                throw new IOException("Invalid browser credential expiry", e);
            }
        }
        if (browsers.size() > MAX_BROWSERS) throw new IOException("Too many browser credentials");
        if (trimmed) persist(browsers);
    }

    synchronized Access access(String token) throws IOException {
        if (!Sessions.validToken(token)) return null;
        String key = Sessions.hash(token);
        Browser browser = browsers.get(key);
        long now = Instant.now().getEpochSecond();
        if (browser == null || browser.expires() <= now) return null;
        boolean renew = now - browser.renewed() >= RENEW_INTERVAL;
        if (renew) {
            Map<String, Browser> updated = liveCopy(now);
            browser = new Browser(browser.users(), browser.selected(), now + Sessions.LIFETIME, now);
            updated.put(key, browser);
            persist(updated); browsers = updated;
        }
        return new Access(browser.users(), browser.selected(), renew);
    }

    synchronized boolean authorizesHash(String hash,String user) {
        Browser browser = browsers.get(hash);
        return browser != null && browser.expires() > Instant.now().getEpochSecond() && browser.users().contains(user);
    }

    // Only call after password authentication or with a verified legacy session.
    synchronized boolean canRemember(String token, String previousUser, String user) throws IOException {
        Access browser = access(token);
        HashSet<String> users = new HashSet<>(browser == null ? List.of() : browser.users());
        if (previousUser != null) users.add(previousUser);
        users.add(user);
        return users.size() <= MAX_ACCOUNTS;
    }

    synchronized String remember(String token, String previousUser, String user) throws IOException {
        if (!AccountStore.validUsername(user) || previousUser != null && !AccountStore.validUsername(previousUser))
            throw new IllegalArgumentException("Invalid browser account");
        long now = Instant.now().getEpochSecond();
        Map<String, Browser> updated = liveCopy(now);
        String key = Sessions.validToken(token) ? Sessions.hash(token) : null;
        Browser browser = key == null ? null : updated.get(key);
        if (browser == null) {
            if (updated.size() >= MAX_BROWSERS) throw new IOException("Browser capacity exceeded");
            do {
                byte[] bytes = new byte[32]; random.nextBytes(bytes);
                token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
                key = Sessions.hash(token);
            } while (updated.containsKey(key));
        }
        List<String> users = new ArrayList<>(browser == null ? List.of() : browser.users());
        if (previousUser != null && !users.contains(previousUser)) users.add(previousUser);
        if (!users.contains(user)) users.add(user);
        if (users.size() > MAX_ACCOUNTS) throw new IllegalStateException("Browser account capacity exceeded");
        updated.put(key, new Browser(List.copyOf(users), user, now + Sessions.LIFETIME, now));
        persist(updated); browsers = updated;
        return token;
    }

    synchronized boolean select(String token, String user) throws IOException {
        if (!Sessions.validToken(token)) return false;
        String key = Sessions.hash(token);
        Browser browser = browsers.get(key);
        long now = Instant.now().getEpochSecond();
        if (browser == null || browser.expires() <= now || !browser.users().contains(user)) return false;
        Map<String, Browser> updated = liveCopy(now);
        updated.put(key, new Browser(browser.users(), user, now + Sessions.LIFETIME, now));
        persist(updated); browsers = updated;
        return true;
    }

    synchronized void remove(String token) throws IOException {
        if (!Sessions.validToken(token) || !browsers.containsKey(Sessions.hash(token))) return;
        Map<String, Browser> updated = liveCopy(Instant.now().getEpochSecond());
        updated.remove(Sessions.hash(token));
        persist(updated); browsers = updated;
    }

    synchronized Access forget(String token, String user) throws IOException {
        if (!Sessions.validToken(token)) return null;
        String key = Sessions.hash(token);
        long now = Instant.now().getEpochSecond();
        Map<String, Browser> updated = liveCopy(now);
        Browser browser = updated.get(key);
        if (browser == null) return null;
        List<String> users = new ArrayList<>(browser.users()); users.remove(user);
        if (users.isEmpty()) {
            updated.remove(key); persist(updated); browsers = updated; return null;
        }
        String selected = users.contains(browser.selected()) ? browser.selected() : users.get(users.size() - 1);
        updated.put(key, new Browser(List.copyOf(users), selected, now + Sessions.LIFETIME, now));
        persist(updated); browsers = updated;
        return new Access(List.copyOf(users), selected, false);
    }

    private Map<String, Browser> liveCopy(long now) {
        Map<String, Browser> updated = new HashMap<>(browsers);
        updated.entrySet().removeIf(entry -> entry.getValue().expires() <= now);
        return updated;
    }

    private void persist(Map<String, Browser> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-browser-accounts-v1\n");
        for (var entry : updated.entrySet()) {
            Browser browser = entry.getValue();
            out.append(entry.getKey()).append('\t').append(browser.expires()).append('\t')
                .append(browser.renewed()).append('\t').append(browser.selected()).append('\t')
                .append(String.join(",", browser.users())).append('\n');
        }
        Path temp = Files.createTempFile(file.getParent(), ".browser-accounts-", ".tmp");
        try {
            Files.setPosixFilePermissions(temp, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(out.toString().getBytes(StandardCharsets.UTF_8));
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temp); }
    }

    record Access(List<String> users, String selected, boolean renewed) { }
    private record Browser(List<String> users, String selected, long expires, long renewed) { }
}
