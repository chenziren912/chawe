package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Private and Saved Messages reactions use stable account IDs, separate from chat history. */
final class ReactionStore {
    private final Path file;
    private Map<String,Map<Long,Map<String,String>>> records=new TreeMap<>();
    ReactionStore(Path directory) throws IOException {
        file=directory.resolve("reactions-v1.tsv");if(!Files.exists(file))return;
        var lines=Files.readAllLines(file,StandardCharsets.UTF_8);
        if(lines.isEmpty()||!lines.get(0).equals("# chawe-reactions-v1"))throw new IOException("Invalid reaction index");
        for(String line:lines.subList(1,lines.size()))try {
            String[] f=line.split("\t",-1);if(f.length!=4||!f[0].matches("u-[a-f0-9]{32}-[a-f0-9]{32}"))throw new IllegalArgumentException();
            String[] members=f[0].substring(2).split("-");long seq=Long.parseLong(f[1]);
            if(seq<1||members[0].compareTo(members[1])>0||!List.of(members).contains(f[2])||!GroupStore.EMOJI.contains(f[3]))throw new IllegalArgumentException();
            var values=records.computeIfAbsent(f[0],key->new TreeMap<>()).computeIfAbsent(seq,key->new TreeMap<>());
            if(values.putIfAbsent(f[2],f[3])!=null)throw new IllegalArgumentException();
        }catch(RuntimeException error){throw new IOException("Invalid reaction record",error);}
    }
    synchronized Map<String,String> get(String key,long seq){return Map.copyOf(records.getOrDefault(key,Map.of()).getOrDefault(seq,Map.of()));}
    synchronized void toggle(String userId,String peerId,long seq,String emoji) throws IOException {
        if(seq<1||emoji==null||!GroupStore.EMOJI.contains(emoji))throw new IllegalArgumentException("invalid_reaction");
        String key=PinStore.key(userId,peerId,false);
        Map<String,Map<Long,Map<String,String>>> next=new TreeMap<>(records);
        Map<Long,Map<String,String>> messages=new TreeMap<>(next.getOrDefault(key,Map.of()));
        Map<String,String> values=new TreeMap<>(messages.getOrDefault(seq,Map.of()));
        if(emoji.equals(values.get(userId)))values.remove(userId);else values.put(userId,emoji);
        if(values.isEmpty())messages.remove(seq);else messages.put(seq,Map.copyOf(values));
        if(messages.isEmpty())next.remove(key);else next.put(key,messages);
        StringBuilder out=new StringBuilder("# chawe-reactions-v1\n");
        for(var conversation:next.entrySet())for(var message:conversation.getValue().entrySet())for(var reaction:message.getValue().entrySet())
            out.append(conversation.getKey()).append('\t').append(message.getKey()).append('\t').append(reaction.getKey()).append('\t').append(reaction.getValue()).append('\n');
        RenameTransaction.atomicWrite(file,out.toString().getBytes(StandardCharsets.UTF_8));records=next;
    }
}
