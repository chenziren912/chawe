package chawe;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.*;

/** Voice uploads and one-time consumption are durable; no recording duration limit. */
final class VoiceStore {
    static final int CHUNK = 512*1024;
    private static final long RESERVE = 1024L*1024*1024;
    record Voice(String id,String owner,String peer,String type,long size,long offset,long duration,String wave,
                 boolean once,String state,long created,boolean consumed) {
        ChatStore.Attachment attachment() { return new ChatStore.Attachment(id,"语音消息",type,size,once ? "voice-once" : "voice"); }
        Voice offset(long n) { return new Voice(id,owner,peer,type,size,n,duration,wave,once,state,created,consumed); }
        Voice state(String s,boolean c) { return new Voice(id,owner,peer,type,size,offset,duration,wave,once,s,created,c); }
    }
    private record GroupOnce(Set<String> recipients,Set<String> consumed,long sequence) { }
    private final Path directory,index,groupIndex;
    private Map<String,Voice> values = new LinkedHashMap<>();
    private Map<String,GroupOnce> groupOnce = new LinkedHashMap<>();
    VoiceStore(Path data) throws IOException {
        directory=data.resolve("voices"); index=data.resolve("voices-v1.tsv"); groupIndex=data.resolve("voice-group-once-v1.tsv"); Files.createDirectories(directory);
        Files.setPosixFilePermissions(directory,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.OWNER_EXECUTE));
        if (Files.exists(index)) {
            var lines=Files.readAllLines(index,StandardCharsets.UTF_8);
            if (lines.isEmpty() || !lines.get(0).equals("# chawe-voices-v1")) throw new IOException("Invalid voice index");
            try { for(String line:lines.subList(1,lines.size())) {
                String[] f=line.split("\t",-1); if(f.length!=12) throw new IllegalArgumentException();
                Voice v=new Voice(f[0],f[1],f[2],f[3],Long.parseLong(f[4]),Long.parseLong(f[5]),Long.parseLong(f[6]),f[7],flag(f[8]),f[9],Long.parseLong(f[10]),flag(f[11]));
                if(!AccountIdentities.validId(v.id()) || !AccountIdentities.validId(v.owner()) || !AccountIdentities.validId(v.peer())
                    || !mime(v.type()) || v.size()<1 || v.size()>9007199254740991L || v.offset()<0 || v.offset()>v.size() || v.duration()<1
                    || v.created()<1 || !List.of("uploading","sent","cancelled").contains(v.state()) || v.consumed() && (!v.once() || !v.state().equals("sent"))) throw new IllegalArgumentException();
                waveform(v.wave()); if(values.putIfAbsent(v.id(),v)!=null) throw new IllegalArgumentException();
                if(v.consumed() || v.state().equals("cancelled")) {Files.deleteIfExists(path(v.id()));Files.deleteIfExists(playable(v.id()));}
                else { Path file=path(v.id()); if(!Files.isRegularFile(file) || Files.size(file)<v.offset()) throw new IOException("Missing voice bytes");
                    if(Files.size(file)>v.offset()) try(FileChannel c=FileChannel.open(file,StandardOpenOption.WRITE)){c.truncate(v.offset());c.force(true);} }
            }} catch(IllegalArgumentException error){throw new IOException("Invalid voice metadata",error);}
        }
        if(Files.exists(groupIndex)) {
            var lines=Files.readAllLines(groupIndex,StandardCharsets.UTF_8);
            if(lines.isEmpty()||!lines.get(0).equals("# chawe-group-once-v1"))throw new IOException("Invalid group voice index");
            try { for(String line:lines.subList(1,lines.size())) {
                String[] fields=line.split("\t",-1);if(fields.length!=4)throw new IllegalArgumentException();
                Voice v=find(fields[0]);Set<String> recipients=ids(fields[1]),used=ids(fields[2]);long sequence=Long.parseLong(fields[3]);
                if(!v.once()||recipients.isEmpty()||recipients.size()>1000||recipients.contains(v.owner())||!recipients.containsAll(used)
                    ||sequence<0||!used.isEmpty()&&sequence<1||v.consumed()&&!used.containsAll(recipients)||groupOnce.putIfAbsent(v.id(),new GroupOnce(recipients,used,sequence))!=null)throw new IllegalArgumentException();
            }}catch(IllegalArgumentException error){throw new IOException("Invalid group voice metadata",error);}
            // Recover the final audience receipt if the process stopped before
            // the legacy global flag was updated. Delete bytes only after it is durable.
            for(var entry:groupOnce.entrySet()) {
                Voice v=find(entry.getKey());GroupOnce receipt=entry.getValue();
                if(v.state().equals("sent")&&receipt.consumed().containsAll(receipt.recipients())) {
                    if(!v.consumed())put(v.state("sent",true));destroy(v.id());
                }
            }
        }
        try(var files=Files.newDirectoryStream(directory,"*.bin")){for(Path f:files)if(!values.containsKey(f.getFileName().toString().replace(".bin","")))Files.delete(f);}
        try(var files=Files.newDirectoryStream(directory,"*.play*")){for(Path f:files){String name=f.getFileName().toString();if(name.matches("[a-f0-9]{32}\\.play(\\.tmp)?")&&(name.endsWith(".tmp")||!values.containsKey(name.substring(0,32))))Files.delete(f);}}
    }
    synchronized Voice create(String id,String owner,String peer,String type,long size,long duration,String wave,boolean once) throws IOException {
        if(!AccountIdentities.validId(id) || !mime(type) || size<1 || size>9007199254740991L || duration<1) throw new IllegalArgumentException("invalid_voice");
        waveform(wave); Voice old=values.get(id);
        if(old!=null){if(!old.owner().equals(owner) || !old.peer().equals(peer) || old.size()!=size || old.duration()!=duration || !old.wave().equals(wave) || old.once()!=once || !old.type().equals(type))throw new IllegalArgumentException("invalid_voice"); return old;}
        if(values.values().stream().filter(v->v.owner().equals(owner)&&v.state().equals("uploading")).count()>=2)throw new IllegalArgumentException("upload_limit");
        long reserved=0; for(Voice v:values.values())if(v.state().equals("uploading")){if(v.size()-v.offset()>Long.MAX_VALUE-reserved)throw new IllegalArgumentException("attachment_storage_full");reserved+=v.size()-v.offset();}
        if(size>Files.getFileStore(directory).getUsableSpace()-RESERVE-reserved)throw new IllegalArgumentException("attachment_storage_full");
        Voice v=new Voice(id,owner,peer,type,size,0,duration,wave,once,"uploading",Instant.now().getEpochSecond(),false);
        Files.createFile(path(id));Files.setPosixFilePermissions(path(id),EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
        try{put(v);}catch(IOException error){Files.deleteIfExists(path(id));throw error;}return v;
    }
    synchronized Voice get(String owner,String id){Voice v=find(id);if(!v.owner().equals(owner))throw new IllegalArgumentException("voice_not_found");return v;}
    synchronized Voice find(String id){Voice v=values.get(id);if(v==null)throw new IllegalArgumentException("voice_not_found");return v;}
    synchronized Voice chunk(String owner,String id,long offset,byte[] data) throws IOException {
        Voice v=get(owner,id);if(!v.state().equals("uploading"))throw new IllegalArgumentException("upload_closed");
        if(offset!=v.offset())throw new IllegalArgumentException("upload_offset");
        if(data.length<1 || data.length>CHUNK || data.length>v.size()-offset)throw new IllegalArgumentException("invalid_upload_chunk");
        if(Files.getFileStore(directory).getUsableSpace()<RESERVE+data.length)throw new IllegalArgumentException("attachment_storage_full");
        try(FileChannel c=FileChannel.open(path(id),StandardOpenOption.WRITE)){c.truncate(offset);c.position(offset);ByteBuffer b=ByteBuffer.wrap(data);while(b.hasRemaining())c.write(b);c.force(true);}
        Voice next=v.offset(offset+data.length);put(next);return next;
    }
    synchronized void ready(Voice v) throws IOException {
        if(!v.state().equals("uploading") || v.offset()!=v.size())throw new IllegalArgumentException("upload_incomplete");
        byte[] bytes;try(var in=Files.newInputStream(path(v.id()))){bytes=in.readNBytes(64);}
        boolean valid=bytes.length>=4 && (v.type().equals("audio/webm") && bytes[0]==26 && bytes[1]==69 && bytes[2]==(byte)223 && bytes[3]==(byte)163
            || v.type().equals("audio/ogg") && new String(bytes,0,4,StandardCharsets.US_ASCII).equals("OggS")
            || v.type().equals("audio/mp4") && bytes.length>=12 && new String(bytes,4,4,StandardCharsets.US_ASCII).equals("ftyp"));
        if(!valid)throw new IllegalArgumentException("invalid_voice_format");
        if(!v.once())makeSeekable(v);
    }
    synchronized Voice sent(Voice v) throws IOException {if(!v.state().equals("sent")){v=v.state("sent",v.consumed());put(v);}return v;}
    synchronized Voice sent(Voice v,long sequence) throws IOException {
        GroupOnce receipt=groupOnce.get(v.id());
        if(receipt!=null) {
            if(sequence<1||receipt.sequence()!=0&&receipt.sequence()!=sequence)throw new IllegalArgumentException("invalid_voice");
            if(receipt.sequence()==0)putGroup(v.id(),new GroupOnce(receipt.recipients(),receipt.consumed(),sequence));
        }
        return sent(v);
    }
    synchronized Voice consume(String id,String user) throws IOException {
        Voice v=find(id);if(!v.once() || !v.peer().equals(user) || !v.state().equals("sent"))throw new IllegalArgumentException("voice_once_only");
        if(v.consumed())throw new IllegalArgumentException("voice_consumed");
        v=v.state("sent",true);put(v);return v;
    }
    synchronized void prepareGroup(Voice v,Collection<String> members) throws IOException {
        if(!v.once()||groupOnce.containsKey(v.id()))return;
        Set<String> recipients=new LinkedHashSet<>(members);recipients.remove(v.owner());
        if(recipients.isEmpty())throw new IllegalArgumentException("group_voice_no_recipients");
        if(recipients.size()>1000||recipients.stream().anyMatch(id->!AccountIdentities.validId(id)))throw new IllegalArgumentException("invalid_voice");
        putGroup(v.id(),new GroupOnce(Set.copyOf(recipients),Set.of(),0));
    }
    synchronized Voice consumeGroup(String id,String user) throws IOException {
        Voice v=find(id);GroupOnce receipt=groupOnce.get(id);
        if(!v.once()||!v.state().equals("sent")||receipt==null||receipt.sequence()<1||!receipt.recipients().contains(user))throw new IllegalArgumentException("voice_once_only");
        if(v.consumed()||receipt.consumed().contains(user))throw new IllegalArgumentException("voice_consumed");
        Set<String> used=new LinkedHashSet<>(receipt.consumed());used.add(user);
        putGroup(id,new GroupOnce(receipt.recipients(),Set.copyOf(used),receipt.sequence()));
        if(used.containsAll(receipt.recipients())) {v=v.state("sent",true);put(v);}
        return v;
    }
    synchronized boolean groupConsumed(String id,String user) {
        Voice v=find(id);if(!v.once())return false;if(v.owner().equals(user))return v.consumed();
        GroupOnce receipt=groupOnce.get(id);
        return v.consumed()||receipt==null||!receipt.recipients().contains(user)||receipt.consumed().contains(user);
    }
    synchronized List<Voice> groupConversation(String peer) {return values.values().stream().filter(v->v.once()&&v.state().equals("sent")&&v.peer().equals(peer)).toList();}
    synchronized long groupSequence(String id) {GroupOnce receipt=groupOnce.get(id);return receipt==null?0:receipt.sequence();}
    synchronized void destroy(String id) throws IOException {Voice v=find(id);if(v.consumed() || v.state().equals("cancelled")){Files.deleteIfExists(path(id));Files.deleteIfExists(playable(id));}}
    synchronized Voice cancel(String owner,String id) throws IOException {
        Voice v=get(owner,id);if(v.state().equals("sent"))throw new IllegalArgumentException("upload_already_sent");v=v.state("cancelled",false);put(v);destroy(id);return v;
    }
    synchronized List<Voice> conversation(String user,String peer){return values.values().stream().filter(v->v.once()&&v.state().equals("sent")&&(v.owner().equals(user)&&v.peer().equals(peer)||v.owner().equals(peer)&&v.peer().equals(user))).toList();}
    synchronized String extraJson(String id){return extraJson(id,null);}
    synchronized String extraJson(String id,String groupViewer){
        Voice v=find(id);return ",\"duration\":"+(v.duration()/1000.0)+",\"waveform\":["+v.wave()+"],\"once\":"+v.once()+",\"consumed\":"+(groupViewer==null?v.consumed():groupConsumed(id,groupViewer));
    }
    synchronized void expire(AccountIdentities identities,ChatStore chats,GroupStore groups) throws IOException {
        for(Voice v:List.copyOf(values.values()))if(v.state().equals("uploading")&&v.created()<Instant.now().getEpochSecond()-86400){
            String owner=identities.username(v.owner()),peer=identities.username(v.peer());
            if(peer==null&&groups.exists(v.peer()))peer=GroupStore.peer(v.peer());
            var message=owner==null||peer==null?null:chats.findAttachment(owner,peer,v.id());
            if(message!=null)sent(v,message.seq());else cancel(v.owner(),v.id());
        }
    }
    Path path(String id){if(!AccountIdentities.validId(id))throw new IllegalArgumentException("voice_not_found");return directory.resolve(id+".bin");}
    Path playable(String id){if(!AccountIdentities.validId(id))throw new IllegalArgumentException("voice_not_found");return directory.resolve(id+".play");}
    private void makeSeekable(Voice v) throws IOException {
        if(Files.isRegularFile(playable(v.id())) && Files.size(playable(v.id()))>0)return;
        if(Files.getFileStore(directory).getUsableSpace()<RESERVE+v.size())throw new IllegalArgumentException("attachment_storage_full");
        Path temp=directory.resolve(v.id()+".play.tmp");Files.deleteIfExists(temp);
        String format=v.type().equals("audio/mp4")?"mp4":v.type().equals("audio/ogg")?"ogg":"webm";
        List<String> args=new ArrayList<>(List.of("/usr/bin/ffmpeg","-nostdin","-hide_banner","-loglevel","error","-protocol_whitelist","file,pipe","-i",path(v.id()).toString(),"-map","0:a:0","-c:a","copy","-vn","-map_metadata","-1"));
        if(format.equals("mp4")){args.add("-movflags");args.add("+faststart");}
        args.addAll(List.of("-f",format,temp.toString()));
        Process process=null;try{
            process=new ProcessBuilder(args).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if(!process.waitFor(120,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();process.waitFor();throw new IllegalArgumentException("voice_processing_failed");}
            if(process.exitValue()!=0 || !Files.isRegularFile(temp)||Files.size(temp)<1)throw new IllegalArgumentException("invalid_voice_format");
            Files.setPosixFilePermissions(temp,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            try(FileChannel channel=FileChannel.open(temp,StandardOpenOption.WRITE)){channel.force(true);}
            Files.move(temp,playable(v.id()),StandardCopyOption.ATOMIC_MOVE);
        }catch(InterruptedException error){if(process!=null)process.destroyForcibly();Thread.currentThread().interrupt();throw new IOException("Voice processing interrupted",error);}
        finally{Files.deleteIfExists(temp);}
    }
    private void put(Voice v) throws IOException {
        Map<String,Voice> next=new LinkedHashMap<>(values);next.put(v.id(),v);StringBuilder text=new StringBuilder("# chawe-voices-v1\n");
        for(Voice r:next.values())text.append(r.id()).append('\t').append(r.owner()).append('\t').append(r.peer()).append('\t').append(r.type()).append('\t').append(r.size()).append('\t').append(r.offset()).append('\t').append(r.duration()).append('\t').append(r.wave()).append('\t').append(r.once()?1:0).append('\t').append(r.state()).append('\t').append(r.created()).append('\t').append(r.consumed()?1:0).append('\n');
        RenameTransaction.atomicWrite(index,text.toString().getBytes(StandardCharsets.UTF_8));values=next;
    }
    private void putGroup(String id,GroupOnce receipt) throws IOException {
        Map<String,GroupOnce> next=new LinkedHashMap<>(groupOnce);next.put(id,receipt);
        StringBuilder text=new StringBuilder("# chawe-group-once-v1\n");
        for(var entry:next.entrySet())text.append(entry.getKey()).append('\t').append(String.join(",",new TreeSet<>(entry.getValue().recipients())))
            .append('\t').append(String.join(",",new TreeSet<>(entry.getValue().consumed()))).append('\t').append(entry.getValue().sequence()).append('\n');
        RenameTransaction.atomicWrite(groupIndex,text.toString().getBytes(StandardCharsets.UTF_8));groupOnce=next;
    }
    private static Set<String> ids(String csv) {
        if(csv.isEmpty())return Set.of();Set<String> result=new LinkedHashSet<>();
        for(String id:csv.split(",",-1))if(!AccountIdentities.validId(id)||!result.add(id))throw new IllegalArgumentException();
        return Set.copyOf(result);
    }
    private static boolean mime(String type){return List.of("audio/webm","audio/ogg","audio/mp4").contains(type);}
    private static boolean flag(String s){if(!s.equals("0")&&!s.equals("1"))throw new IllegalArgumentException();return s.equals("1");}
    private static void waveform(String wave){if(wave==null || wave.length()>512)throw new IllegalArgumentException("invalid_voice");String[] parts=wave.split(",",-1);if(parts.length<8||parts.length>128)throw new IllegalArgumentException("invalid_voice");for(String p:parts){if(!p.matches("[0-9]{1,3}")||Integer.parseInt(p)>100)throw new IllegalArgumentException("invalid_voice");}}
}
