package chawe;

import java.io.BufferedReader;
import java.io.BufferedWriter;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;

/** A durable redo journal commits the whole rename and all session revocations together. */
final class RenameTransaction {
    private static final String POINTER = "username-rename.pending";
    private final Path root,stage;
    private final List<String> plan = new ArrayList<>();
    private boolean committed;
    private RenameTransaction(Path root) throws IOException {
        this.root = root.toAbsolutePath().normalize(); stage = Files.createTempDirectory(this.root,".rename-");
        Files.setPosixFilePermissions(stage,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.OWNER_EXECUTE));
    }
    static void rename(Path root,String oldName,String newName,byte[] identities) throws IOException {
        RenameTransaction tx = new RenameTransaction(root);
        try {
            tx.rows("accounts.tsv",f -> { if (f[0].equals(oldName)) f[0] = newName; return f; });
            tx.rows("sessions.tsv",f -> f[1].equals(oldName) ? null : f);
            tx.rows("browser-accounts-v1.tsv",f -> {
                List<String> users = new ArrayList<>(Arrays.asList(f[4].split(",",-1))); users.remove(oldName);
                if (users.isEmpty()) return null;
                if (f[3].equals(oldName)) f[3] = users.get(users.size()-1);
                f[4] = String.join(",",users); return f;
            });
            tx.rows("registration-devices-v1.tsv",f -> { f[0] = renamed(f[0],oldName,newName); return f; });
            tx.rows("relationships-v2.tsv",f -> { f[1] = renamed(f[1],oldName,newName); f[2] = renamed(f[2],oldName,newName); return f; });
            tx.rows("user-profiles-v1.tsv",f -> {
                f[0] = renamed(f[0],oldName,newName);
                if (!f[7].isEmpty()) f[7] = String.join(",",Arrays.stream(f[7].split(",",-1)).map(user -> renamed(user,oldName,newName)).sorted().toList());
                return f;
            });
            Path avatars = tx.root.resolve("avatars-v1.tsv");
            if (Files.exists(avatars)) for (String line : Files.readAllLines(avatars,StandardCharsets.UTF_8)) {
                if (line.startsWith("#")) continue;
                String[] f = line.split("\t",-1);
                if (f[0].equals(oldName) && !f[2].isEmpty()) tx.move("avatars/" + oldName + "-" + f[2] + ".png","avatars/" + newName + "-" + f[2] + ".png",false,oldName,newName);
            }
            tx.rows("avatars-v1.tsv",f -> { f[0] = renamed(f[0],oldName,newName); return f; });
            try (var files = Files.newDirectoryStream(tx.root.resolve("chats"),"*.log")) {
                for (Path file : files) {
                    String before = file.getFileName().toString(), after = renamedChat(before,oldName,newName);
                    if (before.startsWith("group-") && before.matches("group-[a-f0-9]{32}\\.log")) {
                        tx.groupChat("chats/"+before,oldName,newName);continue;
                    }
                    if (before.equals(after)) continue;
                    tx.move("chats/" + before,"chats/" + after,true,oldName,newName);
                    if (Files.exists(tx.root.resolve("chats/" + before + ".changes"))) tx.move("chats/" + before + ".changes","chats/" + after + ".changes",false,oldName,newName);
                }
            }
            tx.bytes("account-identities-v1.tsv",identities);
            atomicWrite(tx.stage.resolve("manifest.tsv"),(String.join("\n",tx.plan) + "\n").getBytes(StandardCharsets.UTF_8));
            atomicWrite(tx.root.resolve(POINTER),(tx.stage.getFileName() + "\n").getBytes(StandardCharsets.UTF_8));
            tx.committed = true; recover(tx.root);
        } finally { if (!tx.committed) cleanup(tx.stage); }
    }
    private interface Row { String[] update(String[] fields); }
    /** Delete one identity through the same redo journal; usernames are released only after cleanup. */
    static void deleteAccount(Path root,String user,String identity,byte[] identities,byte[] groups) throws IOException {
        if(!AccountStore.validUsername(user)||!AccountIdentities.validId(identity))throw new IllegalArgumentException();
        RenameTransaction tx=new RenameTransaction(root);
        try {
            tx.rows("accounts.tsv",f->f[0].equals(user)?null:f);
            tx.rows("sessions.tsv",f->f[1].equals(user)?null:f);
            tx.rows("browser-accounts-v1.tsv",f->{List<String> users=new ArrayList<>(Arrays.asList(f[4].split(",",-1)));users.remove(user);if(users.isEmpty())return null;if(f[3].equals(user))f[3]=users.get(users.size()-1);f[4]=String.join(",",users);return f;});
            tx.rows("registration-devices-v1.tsv",f->f[0].equals(user)?null:f);
            tx.rows("relationships-v2.tsv",f->f[1].equals(user)||f[2].equals(user)?null:f);
            tx.rows("user-profiles-v1.tsv",f->{if(f[0].equals(user))return null;f[7]=String.join(",",Arrays.stream(f[7].split(",")).filter(name->!name.equals(user)).toList());return f;});
            Path avatars=tx.root.resolve("avatars-v1.tsv");
            if(Files.exists(avatars))for(String line:Files.readAllLines(avatars,StandardCharsets.UTF_8))if(!line.startsWith("#")){String[] f=line.split("\t",-1);if(f[0].equals(user)&&!f[2].isEmpty())tx.plan.add("D\tavatars/"+user+"-"+f[2]+".png");}
            tx.rows("avatars-v1.tsv",f->f[0].equals(user)?null:f);
            java.util.Set<String> removedVoices=new java.util.HashSet<>();
            Path audience=tx.root.resolve("voice-group-once-v1.tsv");
            if(Files.exists(audience))for(String line:Files.readAllLines(audience,StandardCharsets.UTF_8))if(!line.startsWith("#")){String[] f=line.split("\t",-1);if(f[1].equals(identity))removedVoices.add(f[0]);}
            tx.rows("attachments-v1.tsv",f->{if(!f[1].equals(identity)&&!f[2].equals(identity))return f;tx.plan.add("D\tattachments/"+f[0]+".bin");return null;});
            tx.rows("voices-v1.tsv",f->{if(!f[1].equals(identity)&&!f[2].equals(identity)&&!removedVoices.contains(f[0]))return f;removedVoices.add(f[0]);for(String extension:List.of(".bin",".play",".play.tmp"))tx.plan.add("D\tvoices/"+f[0]+extension);return null;});
            tx.rows("voice-group-once-v1.tsv",f->{if(removedVoices.contains(f[0]))return null;for(int i=1;i<=2;i++)f[i]=String.join(",",Arrays.stream(f[i].split(",")).filter(id->!id.equals(identity)).toList());return f;});
            tx.rows("read-receipts-v1.tsv",f->f[0].equals(identity)||f[1].equals(identity)?null:f);
            tx.rows("pins-v1.tsv",f->f[0].startsWith("u-")&&f[0].contains(identity)?null:f);
            tx.rows("reactions-v1.tsv",f->f[0].contains(identity)||f[2].equals(identity)?null:f);
            tx.rows("push-preferences-v1.tsv",f->f[1].equals(identity)?null:f);
            tx.rows("push-outbox-v1.tsv",f->f[3].equals(identity)||f[4].equals(identity)?null:f);
            tx.rows("super-admins-v1.tsv",f->f[0].equals(identity)?null:f);
            try(var files=Files.newDirectoryStream(tx.root.resolve("chats"),"*.log")) {
                for(Path file:files) {
                    String name=file.getFileName().toString(),relative="chats/"+name;
                    if(name.startsWith("group-")){tx.groupChat(relative,user,"__deleted_"+identity);continue;}
                    if(!renamedChat(name,user,"__deleted_"+identity).equals(name)){tx.plan.add("D\t"+relative);if(Files.exists(tx.root.resolve(relative+".changes")))tx.plan.add("D\t"+relative+".changes");}
                }
            }
            tx.bytes("groups-v1.tsv",groups);tx.bytes("account-identities-v1.tsv",identities);
            atomicWrite(tx.stage.resolve("manifest.tsv"),(String.join("\n",tx.plan)+"\n").getBytes(StandardCharsets.UTF_8));
            atomicWrite(tx.root.resolve(POINTER),(tx.stage.getFileName()+"\n").getBytes(StandardCharsets.UTF_8));
            tx.committed=true;recover(tx.root);
        } finally {if(!tx.committed)cleanup(tx.stage);}
    }
    private void rows(String relative,Row transform) throws IOException {
        Path source = root.resolve(relative); if (!Files.exists(source)) return;
        Path output = stage.resolve(Integer.toString(plan.size()));
        try (BufferedReader reader = Files.newBufferedReader(source,StandardCharsets.UTF_8); BufferedWriter writer = Files.newBufferedWriter(output,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("#") || line.equals("chawe-read-receipts-v1")) { writer.write(line); writer.newLine(); continue; }
                String[] fields = transform.update(line.split("\t",-1));
                if (fields != null) { writer.write(String.join("\t",fields)); writer.newLine(); }
            }
        }
        stageWrite(relative,output);
    }
    private void bytes(String relative,byte[] bytes) throws IOException {
        Path output = stage.resolve(Integer.toString(plan.size())); atomicWrite(output,bytes); stageWrite(relative,output);
    }
    private void groupChat(String relative,String oldName,String newName) throws IOException {
        Path output=stage.resolve(Integer.toString(plan.size()));boolean changed=false;
        try(BufferedReader reader=Files.newBufferedReader(root.resolve(relative),StandardCharsets.UTF_8);BufferedWriter writer=Files.newBufferedWriter(output,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW)){
            String line;while((line=reader.readLine())!=null){String[] fields=line.split("\t",-1);if(fields.length<4)throw new IOException("Invalid group chat");if(fields[2].equals(oldName)){fields[2]=newName;changed=true;}writer.write(String.join("\t",fields));writer.newLine();}
        }
        if(changed)stageWrite(relative,output);else Files.delete(output);
    }
    private void move(String before,String after,boolean messages,String oldName,String newName) throws IOException {
        if (Files.exists(root.resolve(after))) throw new IOException("Rename destination already exists");
        Path output = stage.resolve(Integer.toString(plan.size()));
        if (messages) {
            try (var reader = Files.newBufferedReader(root.resolve(before),StandardCharsets.UTF_8); var writer = Files.newBufferedWriter(output,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW)) {
                String line; while ((line = reader.readLine()) != null) {
                    String[] f = line.split("\t",-1); f[2] = renamed(f[2],oldName,newName); writer.write(String.join("\t",f)); writer.newLine();
                }
            }
        } else Files.copy(root.resolve(before),output);
        stageWrite(after,output); plan.add("D\t" + before);
    }
    private void stageWrite(String relative,Path output) throws IOException {
        Files.setPosixFilePermissions(output,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
        try (FileChannel channel = FileChannel.open(output,StandardOpenOption.WRITE)) { channel.force(true); }
        plan.add("W\t" + relative + "\t" + output.getFileName() + "\t" + digest(output));
    }
    private static String renamed(String value,String oldName,String newName) { return value.equals(oldName) ? newName : value; }
    private static String renamedChat(String filename,String oldName,String newName) throws IOException {
        if (filename.equals("self-" + oldName + ".log")) return "self-" + newName + ".log";
        if (filename.startsWith("dm-") && filename.endsWith(".log")) {
            String[] names = filename.substring(3,filename.length()-4).split("-",-1);
            if (names.length != 2) throw new IOException("Invalid chat name");
            names[0] = renamed(names[0],oldName,newName); names[1] = renamed(names[1],oldName,newName); Arrays.sort(names);
            return "dm-" + names[0] + "-" + names[1] + ".log";
        }
        return filename;
    }
    static void recover(Path directory) throws IOException {
        Path root = directory.toAbsolutePath().normalize(), pointer = root.resolve(POINTER);
        if (!Files.exists(pointer)) return;
        String name = Files.readString(pointer,StandardCharsets.UTF_8).strip();
        if (!name.matches("\\.rename-[a-zA-Z0-9_-]+")) throw new IOException("Invalid rename journal");
        Path stage = root.resolve(name); List<String[]> rows = new ArrayList<>();
        for (String line : Files.readAllLines(stage.resolve("manifest.tsv"),StandardCharsets.UTF_8)) {
            String[] f = line.split("\t",-1);
            if (f.length < 2 || !f[0].equals("W") && !f[0].equals("D")) throw new IOException("Invalid rename manifest");
            checkedTarget(root,f[1]);
            if (f[0].equals("W")) {
                if (f.length != 4 || !f[2].matches("[0-9]+") || !f[3].matches("[a-f0-9]{64}") || !digest(stage.resolve(f[2])).equals(f[3])) throw new IOException("Invalid rename snapshot");
            } else if (f.length != 2) throw new IOException("Invalid rename deletion");
            rows.add(f);
        }
        // Never remove the old file until every new payload has reached durable storage.
        for (String[] f : rows) if (f[0].equals("W")) atomicCopy(stage.resolve(f[2]),checkedTarget(root,f[1]));
        var changedDirectories = new java.util.HashSet<Path>();
        for (String[] f : rows) if (f[0].equals("D")) {
            Path target = checkedTarget(root,f[1]); Files.deleteIfExists(target); changedDirectories.add(target.getParent());
        }
        for (Path changed : changedDirectories) forceDirectory(changed);
        Files.delete(pointer); forceDirectory(root); cleanup(stage);
    }
    private static Path checkedTarget(Path root,String relative) throws IOException {
        Path path = root.resolve(relative).normalize();
        if (Path.of(relative).isAbsolute() || !path.startsWith(root) || path.equals(root)
            || !(relative.matches("[a-z0-9-]+\\.tsv") || relative.matches("chats/(?:self|dm)-[A-Za-z0-9_-]+\\.log(?:\\.changes)?")
                || relative.matches("chats/group-[a-f0-9]{32}\\.log")
                || relative.matches("avatars/[A-Za-z0-9_]+-[a-f0-9]{64}\\.png")
                || relative.matches("(?:attachments|voices)/[a-f0-9]{32}\\.(?:bin|play(?:\\.tmp)?)"))) throw new IOException("Invalid rename target");
        return path;
    }
    private static String digest(Path file) throws IOException {
        try {
            var hash = MessageDigest.getInstance("SHA-256");
            try (var input = Files.newInputStream(file)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) >= 0) if (count > 0) hash.update(buffer,0,count); }
            return HexFormat.of().formatHex(hash.digest());
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    static void atomicWrite(Path target,byte[] bytes) throws IOException {
        Path temp = Files.createTempFile(target.getParent(),".identity-",".tmp");
        try {
            Files.setPosixFilePermissions(temp,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp,StandardOpenOption.WRITE)) { ByteBuffer buffer = ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true); }
            Files.move(temp,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); forceDirectory(target.getParent());
        } finally { Files.deleteIfExists(temp); }
    }
    private static void atomicCopy(Path source,Path target) throws IOException {
        Path temp = Files.createTempFile(target.getParent(),".identity-",".tmp");
        try {
            Files.copy(source,temp,StandardCopyOption.REPLACE_EXISTING);
            Files.setPosixFilePermissions(temp,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp,StandardOpenOption.WRITE)) { channel.force(true); }
            Files.move(temp,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); forceDirectory(target.getParent());
        } finally { Files.deleteIfExists(temp); }
    }
    private static void forceDirectory(Path directory) throws IOException { try (FileChannel channel = FileChannel.open(directory,StandardOpenOption.READ)) { channel.force(true); } }
    private static void cleanup(Path stage) throws IOException {
        if (!Files.exists(stage)) return;
        try (var files = Files.newDirectoryStream(stage)) { for (Path file : files) Files.deleteIfExists(file); }
        Files.deleteIfExists(stage);
    }
}
