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
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;

/** Durable registration quotas. A fingerprint is a browser signal, not proof of hardware identity. */
final class RegistrationDevices {
    static final int MAX_ACCOUNTS = 5;
    private final AccountStore accounts;
    private final Path file;
    private Map<String, String> bindings = new LinkedHashMap<>();

    RegistrationDevices(Path directory, AccountStore accounts) throws IOException {
        this.accounts = accounts;
        file = directory.resolve("registration-devices-v1.tsv");
        if (!Files.exists(file)) return;
        boolean cleanup = false;
        Map<String, String> loaded = new LinkedHashMap<>();
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.equals("# chawe-registration-devices-v1")) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length != 2 || !AccountStore.validUsername(fields[0]) || !validFingerprint(fields[1])
                    || loaded.putIfAbsent(fields[0], fields[1]) != null)
                throw new IOException("Invalid registration device file");
        }
        for (var entry : loaded.entrySet()) {
            // A reservation precedes account creation. Recover interrupted, uncommitted writes.
            if (accounts.exists(entry.getKey())) bindings.put(entry.getKey(), entry.getValue());
            else cleanup = true;
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String fingerprint : bindings.values()) {
            if (counts.merge(fingerprint, 1, Integer::sum) > MAX_ACCOUNTS)
                throw new IOException("Registration device capacity exceeded");
        }
        if (cleanup) persist(bindings);
    }

    static boolean validFingerprint(String value) {
        return value != null && value.matches("[0-9a-f]{64}");
    }

    synchronized AccountStore.RegisterResult register(String username, String password, String fingerprint) throws IOException {
        if (!validFingerprint(fingerprint)) return AccountStore.RegisterResult.INVALID_DEVICE;
        if (!AccountStore.validUsername(username) || !Passwords.valid(password)) return AccountStore.RegisterResult.INVALID;
        if (accounts.exists(username)) return AccountStore.RegisterResult.EXISTS;
        if (bindings.values().stream().filter(fingerprint::equals).count() >= MAX_ACCOUNTS)
            return AccountStore.RegisterResult.DEVICE_LIMIT;
        Map<String, String> reserved = new LinkedHashMap<>(bindings);
        reserved.put(username, fingerprint);
        // Force the quota reservation first, so a crash cannot create an uncounted account.
        persist(reserved); bindings = reserved;
        try {
            AccountStore.RegisterResult result = accounts.register(username, password);
            if (result != AccountStore.RegisterResult.CREATED) release(username);
            return result;
        } catch (IOException | RuntimeException error) {
            try { release(username); } catch (IOException cleanupError) { error.addSuppressed(cleanupError); }
            throw error;
        }
    }

    private void release(String username) throws IOException {
        // An account which reached durable storage must retain its quota binding.
        if (accounts.exists(username)) return;
        Map<String, String> updated = new LinkedHashMap<>(bindings);
        updated.remove(username); persist(updated); bindings = updated;
    }

    private void persist(Map<String, String> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-registration-devices-v1\n");
        for (var entry : updated.entrySet()) out.append(entry.getKey()).append('\t').append(entry.getValue()).append('\n');
        Path temp = Files.createTempFile(file.getParent(), ".registration-devices-", ".tmp");
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
}
