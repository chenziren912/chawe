package chawe;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;
import java.util.regex.Pattern;

final class AccountStore {
    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_]{3,20}");
    private static final int MAX_USERS = 200;
    private final Path file;
    private final Map<String, Account> accounts = new LinkedHashMap<>();

    AccountStore(Path directory) throws IOException {
        Files.createDirectories(directory);
        Files.setPosixFilePermissions(directory, EnumSet.of(
            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        file = directory.resolve("accounts.tsv");
        if (!Files.exists(file)) return;
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.equals("# chawe-accounts-v1")) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length != 5 || !USERNAME.matcher(fields[0]).matches()) {
                throw new IOException("Invalid account file");
            }
            try {
                Account old = accounts.putIfAbsent(fields[0], new Account(fields[0],
                    Long.parseLong(fields[1]), new Passwords.Hash(Integer.parseInt(fields[2]), fields[3], fields[4])));
                if (old != null) throw new IOException("Duplicate account in file");
            } catch (NumberFormatException e) {
                throw new IOException("Invalid account file", e);
            }
        }
        if (accounts.size() > MAX_USERS) throw new IOException("Account capacity exceeded");
    }

    static boolean validUsername(String name) {
        return name != null && USERNAME.matcher(name).matches();
    }

    synchronized RegisterResult register(String username, String password) throws IOException {
        if (!validUsername(username) || !Passwords.valid(password)) return RegisterResult.INVALID;
        if (accounts.containsKey(username)) return RegisterResult.EXISTS;
        if (accounts.size() >= MAX_USERS) return RegisterResult.FULL;
        Account account = new Account(username, Instant.now().getEpochSecond(), Passwords.create(password));
        Map<String, Account> updated = new LinkedHashMap<>(accounts);
        updated.put(username, account);
        persist(updated);
        accounts.put(username, account);
        return RegisterResult.CREATED;
    }

    synchronized boolean authenticate(String username, String password) {
        Account account = accounts.get(username);
        if (account == null) return false;
        return Passwords.matches(password, account.hash());
    }

    synchronized boolean exists(String username) {
        return accounts.containsKey(username);
    }

    synchronized List<String> search(String query, String requester) {
        String needle = query.toLowerCase(java.util.Locale.ROOT);
        return accounts.keySet().stream()
            .filter(name -> !name.equals(requester) && name.toLowerCase(java.util.Locale.ROOT).contains(needle))
            .limit(MAX_USERS).toList();
    }

    private void persist(Map<String, Account> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-accounts-v1\n");
        for (Account account : updated.values()) {
            Passwords.Hash hash = account.hash();
            out.append(account.username()).append('\t').append(account.created()).append('\t')
                .append(hash.iterations()).append('\t').append(hash.salt()).append('\t')
                .append(hash.value()).append('\n');
        }
        Path temp = Files.createTempFile(file.getParent(), ".accounts-", ".tmp");
        try {
            Files.setPosixFilePermissions(temp, EnumSet.of(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            byte[] bytes = out.toString().getBytes(StandardCharsets.UTF_8);
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    enum RegisterResult { CREATED, INVALID, EXISTS, FULL, DEVICE_LIMIT, INVALID_DEVICE }
    private record Account(String username, long created, Passwords.Hash hash) { }
}
