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
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Each contact and block belongs to one account. Mutations are durable before returning. */
final class RelationsStore {
    record Person(String username, String alias, boolean contact, boolean blockedByMe, boolean canMessage) { }
    private static final String HEADER = "# chawe-relationships-v2";
    private final Path file;
    private final AccountStore accounts;
    private Map<String, String> contacts = new HashMap<>();
    private Set<String> blocks = new HashSet<>();

    RelationsStore(Path dataDirectory, AccountStore accounts) throws IOException {
        this.accounts = accounts;
        file = dataDirectory.resolve("relationships-v2.tsv");
        if (Files.exists(file)) readCurrent();
        else {
            migrateLegacy(dataDirectory.resolve("relationships.tsv"));
            persist(contacts, blocks); // The new file is also the one-time migration marker.
        }
    }

    private void readCurrent() throws IOException {
        List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        if (lines.isEmpty() || !HEADER.equals(lines.get(0))) throw new IOException("Invalid relationships version");
        for (String line : lines.subList(1, lines.size())) {
            String[] fields = line.split("\t", -1);
            if (fields.length == 4 && fields[0].equals("C") && validPair(fields[1], fields[2])) {
                String alias = decode(fields[3]);
                if (!validAlias(alias) || contacts.putIfAbsent(key(fields[1], fields[2]), alias) != null)
                    throw new IOException("Invalid contact record");
            } else if (fields.length == 3 && fields[0].equals("B") && validPair(fields[1], fields[2])) {
                if (!blocks.add(key(fields[1], fields[2]))) throw new IOException("Duplicate block record");
            } else throw new IOException("Invalid relationships record");
        }
    }

    private void migrateLegacy(Path legacy) throws IOException {
        if (!Files.exists(legacy)) return;
        List<String> lines = Files.readAllLines(legacy, StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("# chawe-relationships-v1"))
            throw new IOException("Invalid legacy relationships version");
        Set<String> pending = new HashSet<>();
        for (String line : lines.subList(1, lines.size())) {
            String[] fields = line.split("\t", -1);
            if (fields.length == 3 && fields[0].equals("F") && validPair(fields[1], fields[2])
                    && fields[1].compareTo(fields[2]) < 0) {
                if (contacts.putIfAbsent(key(fields[1], fields[2]), "") != null)
                    throw new IOException("Duplicate legacy friendship");
                contacts.put(key(fields[2], fields[1]), "");
            } else if (fields.length == 5 && fields[0].equals("R") && validPair(fields[1], fields[2])) {
                String note = decode(fields[4]);
                try {
                    if (Long.parseLong(fields[3]) <= 0 || note.isBlank()
                            || note.codePointCount(0, note.length()) > 200
                            || note.getBytes(StandardCharsets.UTF_8).length > 800
                            || !pending.add(key(fields[1], fields[2])))
                        throw new IOException("Invalid legacy request");
                } catch (NumberFormatException e) { throw new IOException("Invalid legacy request", e); }
                // Pending requests remain in the untouched legacy file and do not grant contacts.
            } else throw new IOException("Invalid legacy relationship record");
        }
    }

    synchronized List<String> contacts(String user) {
        List<String> result = new ArrayList<>();
        for (String pair : contacts.keySet()) if (pair.startsWith(user + '\t')) result.add(pair.substring(user.length() + 1));
        result.sort(Comparator.comparing((String peer) -> displayName(user, peer), String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Comparator.naturalOrder()));
        return result;
    }

    synchronized List<String> blockedUsers(String user) {
        List<String> result = new ArrayList<>();
        for (String pair : blocks) if (pair.startsWith(user + '\t')) result.add(pair.substring(user.length() + 1));
        result.sort(String.CASE_INSENSITIVE_ORDER);
        return result;
    }

    synchronized Person person(String user, String peer) {
        return new Person(peer, contacts.getOrDefault(key(user, peer), ""), contacts.containsKey(key(user, peer)),
            blocks.contains(key(user, peer)), canMessage(user, peer));
    }

    synchronized String displayName(String user, String peer) {
        String alias = contacts.getOrDefault(key(user, peer), "");
        return alias.isEmpty() ? peer : alias;
    }

    synchronized boolean canMessage(String user, String peer) {
        return user.equals(peer) || (!blocks.contains(key(user, peer)) && !blocks.contains(key(peer, user)));
    }

    synchronized void saveContact(String user, String peer, String alias) throws IOException {
        if (!validPair(user, peer) || !validAlias(alias)) throw new IllegalArgumentException("invalid_contact");
        Map<String, String> updated = new HashMap<>(contacts);
        updated.put(key(user, peer), alias.strip());
        persist(updated, blocks);
        contacts = updated;
    }

    synchronized boolean removeContact(String user, String peer) throws IOException {
        if (!contacts.containsKey(key(user, peer))) return false;
        Map<String, String> updated = new HashMap<>(contacts);
        updated.remove(key(user, peer));
        persist(updated, blocks);
        contacts = updated;
        return true;
    }

    synchronized void setBlocked(String user, String peer, boolean blocked) throws IOException {
        if (!validPair(user, peer)) throw new IllegalArgumentException("invalid_user");
        Set<String> updated = new HashSet<>(blocks);
        boolean changed = blocked ? updated.add(key(user, peer)) : updated.remove(key(user, peer));
        if (!changed) return;
        persist(contacts, updated);
        blocks = updated;
    }

    static boolean validAlias(String alias) {
        return alias != null && alias.codePointCount(0, alias.length()) <= 40
            && alias.getBytes(StandardCharsets.UTF_8).length <= 160
            && alias.codePoints().noneMatch(Character::isISOControl);
    }

    private boolean validPair(String owner, String peer) {
        return AccountStore.validUsername(owner) && AccountStore.validUsername(peer) && !owner.equals(peer)
            && accounts.exists(owner) && accounts.exists(peer);
    }

    private void persist(Map<String, String> nextContacts, Set<String> nextBlocks) throws IOException {
        StringBuilder out = new StringBuilder(HEADER).append('\n');
        nextContacts.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(entry ->
            out.append("C\t").append(entry.getKey()).append('\t')
                .append(Base64.getEncoder().encodeToString(entry.getValue().getBytes(StandardCharsets.UTF_8))).append('\n'));
        nextBlocks.stream().sorted().forEach(pair -> out.append("B\t").append(pair).append('\n'));
        Path temp = Files.createTempFile(file.getParent(), ".relationships-v2-", ".tmp");
        try {
            Files.setPosixFilePermissions(temp, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = StandardCharsets.UTF_8.encode(out.toString());
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temp); }
    }

    private static String decode(String value) throws IOException {
        try { return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(Base64.getDecoder().decode(value))).toString(); }
        catch (IllegalArgumentException | java.nio.charset.CharacterCodingException e) { throw new IOException("Invalid UTF-8 record", e); }
    }

    private static String key(String owner, String peer) { return owner + '\t' + peer; }
}
