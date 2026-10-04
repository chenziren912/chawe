package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Shared chat pins, keyed by stable identities so username changes cannot orphan them. */
final class PinStore {
    record Pins(long version,List<Long> sequences) { }
    private final Path file;
    private Map<String,Pins> records=new TreeMap<>();
    PinStore(Path directory) throws IOException {
        file=directory.resolve("pins-v1.tsv");if(!Files.exists(file))return;
        List<String> rows=Files.readAllLines(file,StandardCharsets.UTF_8);
        if(rows.isEmpty()||!rows.get(0).equals("# chawe-pins-v1"))throw new IOException("Invalid pin index");
        for(String row:rows.subList(1,rows.size()))try{
            String[] f=row.split("\t",-1);if(f.length!=3||!validKey(f[0]))throw new IllegalArgumentException();
            long version=Long.parseLong(f[1]);TreeSet<Long> seqs=new TreeSet<>();
            if(!f[2].isEmpty())for(String value:f[2].split(",")){long seq=Long.parseLong(value);if(seq<1||!seqs.add(seq))throw new IllegalArgumentException();}
            if(version<1||seqs.size()>100||records.putIfAbsent(f[0],new Pins(version,List.copyOf(seqs)))!=null)throw new IllegalArgumentException();
        }catch(RuntimeException error){throw new IOException("Invalid pin record",error);}
    }
    static String key(String userId,String peerId,boolean group){
        if(!AccountIdentities.validId(userId)||!AccountIdentities.validId(peerId))throw new IllegalArgumentException("user_not_found");
        return group?"g-"+peerId:"u-"+(userId.compareTo(peerId)<=0?userId+"-"+peerId:peerId+"-"+userId);
    }
    private static boolean validKey(String key){return key.matches("g-[a-f0-9]{32}|u-[a-f0-9]{32}-[a-f0-9]{32}");}
    synchronized Pins get(String key){return records.getOrDefault(key,new Pins(0,List.of()));}
    synchronized Pins set(String key,long seq,boolean pinned) throws IOException {
        if(!validKey(key)||seq<1)throw new IllegalArgumentException("message_not_found");
        Pins old=get(key);TreeSet<Long> sequences=new TreeSet<>(old.sequences());boolean changed=pinned?sequences.add(seq):sequences.remove(seq);
        if(!changed)return old;if(sequences.size()>100)throw new IllegalArgumentException("pins_limit");
        Pins next=new Pins(Math.addExact(old.version(),1),List.copyOf(sequences));Map<String,Pins> updated=new TreeMap<>(records);updated.put(key,next);
        StringBuilder out=new StringBuilder("# chawe-pins-v1\n");
        for(var e:updated.entrySet())out.append(e.getKey()).append('\t').append(e.getValue().version()).append('\t').append(e.getValue().sequences().stream().map(String::valueOf).collect(java.util.stream.Collectors.joining(","))).append('\n');
        RenameTransaction.atomicWrite(file,out.toString().getBytes(StandardCharsets.UTF_8));records=updated;return next;
    }
}
