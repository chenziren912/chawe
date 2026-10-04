package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/** Monotonic read positions keyed by stable identities, independent of usernames. */
final class ReadReceipts {
    private final Path file;
    private Map<String,Long> positions = new HashMap<>();

    ReadReceipts(Path directory) throws IOException {
        file = directory.resolve("read-receipts-v1.tsv");
        if (!Files.exists(file)) return;
        var lines = Files.readAllLines(file,StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("chawe-read-receipts-v1")) throw new IOException("Invalid read receipt version");
        try {
            for (int i = 1; i < lines.size(); i++) {
                String[] parts = lines.get(i).split("\t",-1);
                if (parts.length != 3 || !AccountIdentities.validId(parts[0]) || !AccountIdentities.validId(parts[1])) throw new IllegalArgumentException();
                long seq = Long.parseLong(parts[2]);
                if (seq < 1 || positions.putIfAbsent(parts[0] + "\t" + parts[1],seq) != null) throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException error) { throw new IOException("Invalid read receipts",error); }
    }

    synchronized long through(String reader,String peer) { return positions.getOrDefault(reader + "\t" + peer,0L); }

    synchronized long mark(String reader,String peer,long seq) throws IOException {
        if (!AccountIdentities.validId(reader) || !AccountIdentities.validId(peer) || seq < 1) throw new IllegalArgumentException();
        String key = reader + "\t" + peer;
        long previous = positions.getOrDefault(key,0L);
        if (seq <= previous) return previous;
        Map<String,Long> next = new HashMap<>(positions); next.put(key,seq);
        StringBuilder data = new StringBuilder("chawe-read-receipts-v1\n");
        next.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(entry -> data.append(entry.getKey()).append('\t').append(entry.getValue()).append('\n'));
        RenameTransaction.atomicWrite(file,data.toString().getBytes(StandardCharsets.UTF_8));
        positions = next;
        return seq;
    }
}
