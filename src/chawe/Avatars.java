package chawe;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.MemoryCacheImageInputStream;

/** Immutable image files are written before their atomically replaced index. */
final class Avatars {
    static final int MAX_UPLOAD = 2 * 1024 * 1024;
    record Avatar(String hash, long revision) { }
    private final Path index, directory;
    private Map<String,Avatar> avatars = new HashMap<>();

    Avatars(Path data, AccountStore accounts) throws IOException {
        index = data.resolve("avatars-v1.tsv"); directory = data.resolve("avatars");
        Files.createDirectories(directory);
        Files.setPosixFilePermissions(directory,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.OWNER_EXECUTE));
        if (!Files.exists(index)) return;
        var lines = Files.readAllLines(index,StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("# chawe-avatars-v1")) throw new IOException("Invalid avatar version");
        for (String line : lines.subList(1,lines.size())) {
            String[] f = line.split("\t",-1);
            if (f.length != 3 || !accounts.exists(f[0]) || !AccountStore.validUsername(f[0])
                || !f[2].isEmpty() && !f[2].matches("[a-f0-9]{64}")) throw new IOException("Invalid avatar record");
            try {
                Avatar avatar = new Avatar(f[2],Long.parseLong(f[1]));
                if (avatar.revision() <= 0 || avatars.putIfAbsent(f[0],avatar) != null) throw new IOException("Invalid avatar revision");
                if (!avatar.hash().isEmpty() && (!Files.isRegularFile(image(f[0],avatar.hash())) || Files.size(image(f[0],avatar.hash())) > MAX_UPLOAD))
                    throw new IOException("Missing avatar image");
            } catch (NumberFormatException error) { throw new IOException("Invalid avatar data",error); }
        }
    }

    synchronized Avatar get(String user) { return avatars.getOrDefault(user,new Avatar("",0)); }
    synchronized byte[] read(String user,String version) throws IOException {
        Avatar avatar = get(user);
        return avatar.hash().isEmpty() || version != null && !version.equals(avatar.hash()) ? null : Files.readAllBytes(image(user,avatar.hash()));
    }
    synchronized Avatar save(String user, byte[] input, long expected) throws IOException {
        Avatar before = get(user);
        if (before.revision() != expected) throw new IllegalArgumentException("avatar_changed");
        byte[] canonical = normalize(input);
        String hash;
        try { hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical)); }
        catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
        Path target = image(user,hash);
        if (!Files.exists(target)) atomicWrite(target,canonical);
        Avatar avatar = new Avatar(hash,Math.addExact(before.revision(),1));
        Map<String,Avatar> updated = new HashMap<>(avatars); updated.put(user,avatar);
        try { persist(updated); }
        catch (IOException error) { if (!hash.equals(before.hash())) removeImage(target); throw error; }
        avatars = updated;
        if (!before.hash().isEmpty() && !before.hash().equals(hash)) removeImage(image(user,before.hash()));
        return avatar;
    }
    synchronized Avatar reset(String user, long expected) throws IOException {
        Avatar before = get(user);
        if (before.revision() != expected) throw new IllegalArgumentException("avatar_changed");
        Avatar avatar = new Avatar("",Math.addExact(before.revision(),1));
        Map<String,Avatar> updated = new HashMap<>(avatars); updated.put(user,avatar);
        persist(updated); avatars = updated;
        if (!before.hash().isEmpty()) removeImage(image(user,before.hash()));
        return avatar;
    }
    private Path image(String user,String hash) { return directory.resolve(user + "-" + hash + ".png"); }
    private static void removeImage(Path file) {
        try { Files.deleteIfExists(file); } catch (IOException ignored) { /* A failed cleanup must not undo a durable update. */ }
    }
    private void persist(Map<String,Avatar> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-avatars-v1\n");
        for (String user : updated.keySet().stream().sorted().toList()) {
            Avatar a = updated.get(user); out.append(user).append('\t').append(a.revision()).append('\t').append(a.hash()).append('\n');
        }
        atomicWrite(index,out.toString().getBytes(StandardCharsets.UTF_8));
    }
    private static void atomicWrite(Path target,byte[] bytes) throws IOException {
        Path temp = Files.createTempFile(target.getParent(),".avatar-",".tmp");
        try {
            Files.setPosixFilePermissions(temp,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp,StandardOpenOption.WRITE)) {
                ByteBuffer data = ByteBuffer.wrap(bytes); while (data.hasRemaining()) channel.write(data); channel.force(true);
            }
            Files.move(temp,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temp); }
    }
    static byte[] normalize(byte[] input) throws IOException {
        if (input.length < 24 || input.length > MAX_UPLOAD || input[0] != (byte)137 || input[1] != 80 || input[2] != 78 || input[3] != 71
            || input[4] != 13 || input[5] != 10 || input[6] != 26 || input[7] != 10) throw new IllegalArgumentException("invalid_avatar");
        BufferedImage source;
        try (var stream = new MemoryCacheImageInputStream(new ByteArrayInputStream(input))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) throw new IllegalArgumentException("invalid_avatar");
            ImageReader reader = readers.next();
            try {
                reader.setInput(stream,true,true); int w = reader.getWidth(0), h = reader.getHeight(0);
                if (!reader.getFormatName().equalsIgnoreCase("png") || w <= 0 || h <= 0 || w > 2048 || h > 2048)
                    throw new IllegalArgumentException("invalid_avatar");
                source = reader.read(0);
            } finally { reader.dispose(); }
        } catch (IOException error) { throw new IllegalArgumentException("invalid_avatar",error); }
        if (source == null) throw new IllegalArgumentException("invalid_avatar");
        BufferedImage picture = new BufferedImage(512,512,BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = picture.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            int side = Math.min(source.getWidth(),source.getHeight()), x = (source.getWidth()-side)/2, y = (source.getHeight()-side)/2;
            graphics.drawImage(source,0,0,512,512,x,y,x+side,y+side,null);
        } finally { graphics.dispose(); source.flush(); }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try { if (!ImageIO.write(picture,"png",bytes)) throw new IOException("PNG encoder unavailable"); }
        finally { picture.flush(); }
        if (bytes.size() > MAX_UPLOAD) throw new IllegalArgumentException("invalid_avatar");
        return bytes.toByteArray();
    }
}
