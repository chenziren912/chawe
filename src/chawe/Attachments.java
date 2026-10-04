package chawe;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.Base64;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Upload bytes are durable before their offset. A chat record is the commit point. */
final class Attachments {
    static final long MAX_IMAGE = 20L * 1024 * 1024, MAX_VIDEO = 100L * 1024 * 1024, MAX_FILE = 200L * 1024 * 1024;
    static final long MAX_VIDEO_SECONDS = 10 * 60;
    static final int CHUNK = 512 * 1024;
    private static final long QUOTA = 2L * 1024 * 1024 * 1024, RESERVE = 1024L * 1024 * 1024;
    record Upload(String id,String owner,String peer,String name,String type,String kind,long size,long offset,long created,String state) {
        ChatStore.Attachment attachment() { return new ChatStore.Attachment(id,name,type,size,kind); }
        Upload updated(long offset,String type,String kind,String state) { return new Upload(id,owner,peer,name,type,kind,size,offset,created,state); }
    }
    private final Path directory,index;
    private Map<String,Upload> values = new LinkedHashMap<>();
    private final Map<String,String> inspectedTypes = new LinkedHashMap<>();

    Attachments(Path data) throws IOException {
        directory = data.resolve("attachments"); index = data.resolve("attachments-v1.tsv");
        Files.createDirectories(directory);
        Files.setPosixFilePermissions(directory,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.OWNER_EXECUTE));
        if (Files.exists(index)) {
            var lines = Files.readAllLines(index,StandardCharsets.UTF_8);
            if (lines.isEmpty() || !lines.get(0).equals("# chawe-attachments-v1")) throw new IOException("Invalid attachment index");
            try {
                for (String line : lines.subList(1,lines.size())) {
                    String[] f = line.split("\t",-1);
                    if (f.length != 10) throw new IllegalArgumentException();
                    Upload u = new Upload(f[0],f[1],f[2],new String(Base64.getDecoder().decode(f[3]),StandardCharsets.UTF_8),
                        f[4],f[5],Long.parseLong(f[6]),Long.parseLong(f[7]),Long.parseLong(f[8]),f[9]);
                    if (!AccountIdentities.validId(u.id) || !AccountIdentities.validId(u.owner) || !AccountIdentities.validId(u.peer)
                        || !List.of("uploading","ready","sent","cancelled").contains(u.state) || u.size < 1 || u.size > MAX_FILE
                        || u.offset < 0 || u.offset > u.size || u.created < 1 || !List.of("file","image","video").contains(u.kind)
                        || !u.type.matches("[a-z0-9.+-]+/[a-z0-9.+-]+") || !filename(u.name).equals(u.name)
                        || values.putIfAbsent(u.id,u) != null) throw new IllegalArgumentException();
                    Path file = path(u.id);
                    if (!u.state.equals("cancelled")) {
                        if (!Files.isRegularFile(file) || Files.size(file) < u.offset) throw new IOException("Missing attachment bytes");
                        if (Files.size(file) > u.offset) try (FileChannel channel = FileChannel.open(file,StandardOpenOption.WRITE)) { channel.truncate(u.offset); channel.force(true); }
                        Files.setPosixFilePermissions(file,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
                    } else Files.deleteIfExists(file);
                }
            } catch (IllegalArgumentException error) { throw new IOException("Invalid attachment index",error); }
        }
        // Unknown blobs can only be an interrupted creation, never a committed message.
        try (var files = Files.newDirectoryStream(directory,"*.bin")) {
            for (Path file : files) if (!values.containsKey(file.getFileName().toString().replace(".bin",""))) Files.delete(file);
        }
    }

    synchronized Upload create(String owner,String peer,String name,long size,boolean asFile,String requestId) throws IOException {
        if (size < 1 || size > MAX_FILE) throw new IllegalArgumentException("attachment_file_too_large");
        if (!AccountIdentities.validId(owner) || !AccountIdentities.validId(peer)) throw new IllegalArgumentException("invalid_user");
        name = filename(name);
        if (!AccountIdentities.validId(requestId)) throw new IllegalArgumentException("invalid_upload_id");
        Upload existing = values.get(requestId);
        if (existing != null) {
            if (!existing.owner.equals(owner) || !existing.peer.equals(peer) || !existing.name.equals(name) || existing.size != size)
                throw new IllegalArgumentException("invalid_upload_id");
            return existing;
        }
        String category=category("application/octet-stream",name);
        checkSize(category,size);
        if (values.values().stream().filter(u -> u.owner.equals(owner) && (u.state.equals("uploading") || u.state.equals("ready"))).count() >= 2)
            throw new IllegalArgumentException("upload_limit");
        long reserved = values.values().stream().filter(u -> !u.state.equals("cancelled")).mapToLong(Upload::size).sum();
        long remaining = values.values().stream().filter(u -> !u.state.equals("cancelled") && !u.state.equals("sent")).mapToLong(u -> u.size-u.offset).sum();
        if (reserved + size > QUOTA || Files.getFileStore(directory).getUsableSpace() - remaining - size < RESERVE)
            throw new IllegalArgumentException("attachment_storage_full");
        String id = requestId;
        Upload u = new Upload(id,owner,peer,name,"application/octet-stream",asFile ? "file" : category,size,0,Instant.now().getEpochSecond(),"uploading");
        Path file = path(id); Files.createFile(file);
        Files.setPosixFilePermissions(file,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
        try { put(u); } catch (IOException error) { Files.deleteIfExists(file); throw error; }
        return u;
    }
    synchronized Upload get(String owner,String id) {
        Upload u = values.get(id);
        if (u == null || !u.owner.equals(owner)) throw new IllegalArgumentException("upload_not_found");
        return u;
    }
    synchronized Upload chunk(String owner,String id,long offset,byte[] bytes) throws IOException {
        Upload u = get(owner,id);
        if (!u.state.equals("uploading")) throw new IllegalArgumentException("upload_closed");
        if (offset != u.offset) throw new IllegalArgumentException("upload_offset");
        if (bytes.length < 1 || bytes.length > CHUNK || offset + bytes.length > u.size) throw new IllegalArgumentException("invalid_upload_chunk");
        try (FileChannel channel = FileChannel.open(path(id),StandardOpenOption.WRITE)) {
            channel.truncate(offset); channel.position(offset); ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
        }
        Upload next = u.updated(offset + bytes.length,u.type,u.kind,u.state);
        put(next); return next;
    }
    void inspectForSend(String owner,String id) throws IOException {
        Upload u;
        synchronized(this){
            u=get(owner,id);if(u.state.equals("sent")||inspectedTypes.containsKey(id))return;
            if(!u.state.equals("uploading")&&!u.state.equals("ready"))throw new IllegalArgumentException("upload_closed");
            if(u.offset!=u.size)throw new IllegalArgumentException("upload_incomplete");
        }
        byte[] head;try(var input=Files.newInputStream(path(id))){head=input.readNBytes(32);}
        String type=sniff(head),category=category(type,u.name);
        checkSize(category,u.size);
        // Slow probing must not hold the attachment or relationship locks.
        if(category.equals("video"))VideoProbe.check(path(id),MAX_VIDEO_SECONDS);
        synchronized(this){
            Upload current=get(owner,id);
            if(current.state.equals("sent"))return;
            if(current.state.equals("cancelled"))throw new IllegalArgumentException("upload_closed");
            if(current.offset!=current.size)throw new IllegalArgumentException("upload_incomplete");
            inspectedTypes.put(id,type);
        }
    }
    synchronized Upload ready(String owner,String id) throws IOException {
        Upload u = get(owner,id);
        if (u.state.equals("sent")) return u;
        if (!u.state.equals("uploading")&&!u.state.equals("ready")) throw new IllegalArgumentException("upload_closed");
        if (u.offset != u.size) throw new IllegalArgumentException("upload_incomplete");
        String type=inspectedTypes.get(id);if(type==null)throw new IllegalArgumentException("attachment_validation_required");
        String kind = u.kind.equals("file") ? "file" : type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : "file";
        Upload next = u.updated(u.offset,type,kind,"ready"); put(next); return next;
    }
    synchronized void sent(Upload u) throws IOException { if (!u.state.equals("sent")) put(u.updated(u.offset,u.type,u.kind,"sent"));inspectedTypes.remove(u.id); }
    synchronized Upload cancel(String owner,String id) throws IOException {
        Upload u = get(owner,id);
        if (u.state.equals("sent")) throw new IllegalArgumentException("upload_already_sent");
        if (!u.state.equals("cancelled")) { u = u.updated(u.offset,u.type,u.kind,"cancelled"); put(u); }
        inspectedTypes.remove(id);Files.deleteIfExists(path(id)); return u;
    }
    synchronized void expire(AccountIdentities identities,ChatStore chats,GroupStore groups) throws IOException {
        long now = Instant.now().getEpochSecond();
        for (Upload u : List.copyOf(values.values())) {
            if (u.state.equals("sent") || now-u.created < 24*3600L) continue;
            String owner = identities.username(u.owner),peer = identities.username(u.peer);
            if(peer==null&&groups.exists(u.peer))peer=GroupStore.peer(u.peer);
            if (owner != null && peer != null && chats.findAttachment(owner,peer,u.id) != null) { sent(u); continue; }
            if (!u.state.equals("cancelled")) cancel(u.owner,u.id);
            Map<String,Upload> next = new LinkedHashMap<>(values); next.remove(u.id); persist(next); values = next;
        }
    }
    Path path(String id) { if (!AccountIdentities.validId(id)) throw new IllegalArgumentException("upload_not_found"); return directory.resolve(id + ".bin"); }
    private void put(Upload u) throws IOException { Map<String,Upload> next = new LinkedHashMap<>(values); next.put(u.id,u); persist(next); values = next; }
    private void persist(Map<String,Upload> values) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-attachments-v1\n");
        for (Upload u : values.values()) out.append(u.id).append('\t').append(u.owner).append('\t').append(u.peer).append('\t')
            .append(Base64.getEncoder().encodeToString(u.name.getBytes(StandardCharsets.UTF_8))).append('\t').append(u.type).append('\t').append(u.kind)
            .append('\t').append(u.size).append('\t').append(u.offset).append('\t').append(u.created).append('\t').append(u.state).append('\n');
        RenameTransaction.atomicWrite(index,out.toString().getBytes(StandardCharsets.UTF_8));
    }
    private static String filename(String name) {
        if (name == null) throw new IllegalArgumentException("invalid_filename");
        String clean = name.replaceAll("[\\p{Cntrl}/\\\\]", "_").strip();
        if (clean.isEmpty() || clean.codePointCount(0,clean.length()) > 200) throw new IllegalArgumentException("invalid_filename");
        return clean;
    }
    private static String category(String type,String name){
        if(type.startsWith("image/"))return "image";if(type.startsWith("video/"))return "video";
        String lower=name.toLowerCase(java.util.Locale.ROOT);
        if(lower.matches(".*\\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|ico|svg)$"))return "image";
        if(lower.matches(".*\\.(mp4|webm|mov|m4v|avi|mkv|wmv|flv|mpeg|mpg|m2ts|ts|ogv|3gp|3g2)$"))return "video";
        return "file";
    }
    private static void checkSize(String category,long size){
        long limit=category.equals("image")?MAX_IMAGE:category.equals("video")?MAX_VIDEO:MAX_FILE;
        if(size>limit)throw new IllegalArgumentException("attachment_"+category+"_too_large");
    }
    private static String sniff(byte[] h) {
        if (h.length >= 8 && h[0] == (byte)137 && h[1] == 80 && h[2] == 78 && h[3] == 71 && h[4] == 13 && h[5] == 10 && h[6] == 26 && h[7] == 10) return "image/png";
        if (h.length >= 3 && h[0] == (byte)255 && h[1] == (byte)216 && h[2] == (byte)255) return "image/jpeg";
        String ascii = new String(h,StandardCharsets.ISO_8859_1);
        if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
        if (ascii.startsWith("RIFF") && h.length >= 12 && ascii.substring(8,12).equals("WEBP")) return "image/webp";
        if(ascii.startsWith("BM"))return "image/bmp";
        if(h.length>=4&&(h[0]==73&&h[1]==73&&h[2]==42&&h[3]==0||h[0]==77&&h[1]==77&&h[2]==0&&h[3]==42))return "image/tiff";
        if(h.length>=4&&h[0]==0&&h[1]==0&&h[2]==1&&h[3]==0)return "image/x-icon";
        if(h.length>=12&&ascii.substring(4,8).equals("ftyp")){
            String brand=ascii.substring(8,12);
            if(brand.matches("avif|avis"))return "image/avif";
            if(brand.matches("heic|heix|hevc|hevx|mif1|msf1"))return "image/heif";
            if(brand.equals("M4A "))return "audio/mp4";
            return "video/mp4";
        }
        if (h.length >= 4 && h[0] == 26 && h[1] == 69 && h[2] == (byte)223 && h[3] == (byte)163) return "video/webm";
        return "application/octet-stream";
    }
}
