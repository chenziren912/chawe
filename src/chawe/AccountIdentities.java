package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Public usernames may be reused. Identity and rename cooldown stay with the account. */
final class AccountIdentities {
    static final long RENAME_INTERVAL = 15L * 24 * 60 * 60;
    private record Identity(String id,long changed) { }
    private final Path file;
    private final AccountStore accounts;
    private Map<String,Identity> identities = new LinkedHashMap<>();
    private long generation = 1;

    AccountIdentities(Path directory,AccountStore accounts) throws IOException {
        this.accounts = accounts; file = directory.resolve("account-identities-v1.tsv");
        if (Files.exists(file)) {
            var lines = Files.readAllLines(file,StandardCharsets.UTF_8);
            try {
                String[] header = lines.get(0).split("\t",-1);
                if (header.length != 2 || !header[0].equals("# chawe-account-identities-v1")) throw new IllegalArgumentException();
                generation = Long.parseLong(header[1]); if (generation <= 0) throw new IllegalArgumentException();
                HashSet<String> seen = new HashSet<>();
                for (String line : lines.subList(1,lines.size())) {
                    String[] f = line.split("\t",-1); long changed = f.length == 3 ? Long.parseLong(f[2]) : -1;
                    if (f.length != 3 || !AccountStore.validUsername(f[0]) || !accounts.exists(f[0]) || !validId(f[1])
                        || changed < 0 || !seen.add(f[1]) || identities.putIfAbsent(f[0],new Identity(f[1],changed)) != null)
                        throw new IllegalArgumentException();
                }
            } catch (IllegalArgumentException | IndexOutOfBoundsException error) { throw new IOException("Invalid account identities",error); }
        }
        boolean changed = false;
        for (String user : accounts.search("","")) if (!identities.containsKey(user)) { identities.put(user,new Identity(newId(),0)); changed = true; }
        if (changed) RenameTransaction.atomicWrite(file,serialize(identities,generation));
    }
    synchronized String ensure(String user) throws IOException {
        if (!accounts.exists(user)) throw new IllegalArgumentException("invalid_user");
        Identity identity = identities.get(user);
        if (identity != null) return identity.id();
        Map<String,Identity> updated = new LinkedHashMap<>(identities); identity = new Identity(newId(),0); updated.put(user,identity);
        RenameTransaction.atomicWrite(file,serialize(updated,generation)); identities = updated; return identity.id();
    }
    synchronized String id(String user) { Identity value = identities.get(user); return value == null ? "" : value.id(); }
    synchronized String username(String id) {
        if (!validId(id)) return null;
        return identities.entrySet().stream().filter(e -> e.getValue().id().equals(id)).map(Map.Entry::getKey).findFirst().orElse(null);
    }
    synchronized long generation() { return generation; }
    synchronized long allowedAt(String user) {
        Identity value = identities.get(user); return value == null || value.changed() == 0 ? 0 : value.changed() + RENAME_INTERVAL;
    }
    synchronized byte[] renamed(String oldName,String newName,long now) {
        Identity identity = identities.get(oldName);
        if (identity == null || identities.containsKey(newName)) throw new IllegalArgumentException("username_taken");
        Map<String,Identity> updated = new LinkedHashMap<>(identities); updated.remove(oldName); updated.put(newName,new Identity(identity.id(),now));
        return serialize(updated,Math.addExact(generation,1));
    }
    static boolean validId(String id) { return id != null && id.matches("[a-f0-9]{32}"); }
    synchronized byte[] deleted(String user) {
        Map<String,Identity> updated=new LinkedHashMap<>(identities);if(updated.remove(user)==null)throw new IllegalArgumentException("user_not_found");
        return serialize(updated,Math.addExact(generation,1));
    }
    private String newId() { String id; do { id = UUID.randomUUID().toString().replace("-",""); } while (username(id) != null); return id; }
    private static byte[] serialize(Map<String,Identity> values,long generation) {
        StringBuilder text = new StringBuilder("# chawe-account-identities-v1\t").append(generation).append('\n');
        for (var e : values.entrySet()) text.append(e.getKey()).append('\t').append(e.getValue().id()).append('\t').append(e.getValue().changed()).append('\n');
        return text.toString().getBytes(StandardCharsets.UTF_8);
    }
}
