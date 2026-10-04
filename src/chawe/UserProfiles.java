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
import java.time.LocalDate;
import java.time.Period;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Profile data and contact disclosure rules belong to their owner. */
final class UserProfiles {
    record Profile(String username, String nickname, String birthday, String phone, String email,
                   String visibility, List<String> neverShowTo, long revision) { }
    private final AccountStore accounts;
    private final Path file;
    private Map<String, Profile> profiles = new LinkedHashMap<>();

    UserProfiles(Path directory, AccountStore accounts) throws IOException {
        this.accounts = accounts; file = directory.resolve("user-profiles-v1.tsv");
        if (!Files.exists(file)) return;
        List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("# chawe-user-profiles-v1")) throw new IOException("Invalid profile version");
        for (String line : lines.subList(1,lines.size())) {
            String[] fields = line.split("\t",-1);
            if (fields.length != 8 || !accounts.exists(fields[0])) throw new IOException("Invalid profile record");
            try {
                long revision = Long.parseLong(fields[1]);
                Profile profile = normalized(fields[0],decode(fields[2]),fields[3],decode(fields[4]),decode(fields[5]),fields[6],fields[7],revision);
                if (revision <= 0 || profiles.putIfAbsent(fields[0],profile) != null) throw new IOException("Invalid profile revision");
            } catch (IllegalArgumentException error) { throw new IOException("Invalid profile data",error); }
        }
    }

    synchronized Profile get(String user) {
        return profiles.getOrDefault(user,new Profile(user,"","","","","contacts",List.of(),0));
    }

    synchronized String nickname(String user) { return get(user).nickname(); }

    synchronized Profile save(String user, String nickname, String birthday, String phone, String email,
                              String visibility, String excluded, long expectedRevision) throws IOException {
        Profile current = get(user);
        if (current.revision() != expectedRevision) throw new InvalidProfile("profile_changed");
        Profile profile = normalized(user,nickname,birthday,phone,email,visibility,excluded,Math.addExact(current.revision(),1));
        Map<String, Profile> updated = new LinkedHashMap<>(profiles); updated.put(user,profile);
        persist(updated); profiles = updated; return profile;
    }

    private Profile normalized(String user, String nickname, String birthday, String phone, String email,
                               String visibility, String excluded, long revision) {
        if (!AccountStore.validUsername(user) || !accounts.exists(user)) throw new InvalidProfile("invalid_user");
        nickname = nickname.strip(); birthday = birthday.strip(); phone = phone.strip(); email = email.strip();
        if (!validText(nickname,40,160)) throw new InvalidProfile("invalid_nickname");
        if (!birthday.isEmpty()) {
            try {
                if (!birthday.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new IllegalArgumentException();
                LocalDate date = LocalDate.parse(birthday);
                if (date.isBefore(LocalDate.of(1900,1,1)) || date.isAfter(LocalDate.now(ZoneOffset.UTC).minusYears(18)))
                    throw new IllegalArgumentException();
            } catch (java.time.DateTimeException | IllegalArgumentException error) { throw new InvalidProfile("invalid_birthday"); }
        }
        if (!phone.isEmpty()) {
            long digits = phone.chars().filter(Character::isDigit).count();
            if (phone.length() > 40 || !phone.matches("[+0-9 ().-]+") || digits < 6 || digits > 20
                    || phone.indexOf('+') > 0 || phone.chars().filter(c -> c == '+').count() > 1)
                throw new InvalidProfile("invalid_phone");
        }
        if (!email.isEmpty() && (!validText(email,254,512) || !email.matches("[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+")))
            throw new InvalidProfile("invalid_email");
        if (!List.of("everyone","contacts").contains(visibility)) throw new InvalidProfile("invalid_privacy");
        List<String> never = new ArrayList<>(); HashSet<String> seen = new HashSet<>();
        if (!excluded.isEmpty()) {
            for (String peer : excluded.split(",",-1)) {
                if (!AccountStore.validUsername(peer) || peer.equals(user) || !accounts.exists(peer) || !seen.add(peer))
                    throw new InvalidProfile("invalid_profile_exclusions");
                never.add(peer);
            }
        }
        if (never.size() > 199) throw new InvalidProfile("invalid_profile_exclusions");
        never.sort(String::compareTo);
        return new Profile(user,nickname,birthday,phone,email,visibility,List.copyOf(never),revision);
    }

    static int age(Profile profile) {
        return profile.birthday().isEmpty() ? 0 : Period.between(LocalDate.parse(profile.birthday()),LocalDate.now(ZoneOffset.UTC)).getYears();
    }

    private static boolean validText(String value, int max, int bytes) {
        return value.codePointCount(0,value.length()) <= max && value.getBytes(StandardCharsets.UTF_8).length <= bytes
            && value.codePoints().noneMatch(c -> Character.isISOControl(c) || c >= 0xd800 && c <= 0xdfff);
    }

    private void persist(Map<String, Profile> updated) throws IOException {
        StringBuilder out = new StringBuilder("# chawe-user-profiles-v1\n");
        for (Profile p : updated.values()) out.append(p.username()).append('\t').append(p.revision()).append('\t')
            .append(encode(p.nickname())).append('\t').append(p.birthday()).append('\t').append(encode(p.phone())).append('\t')
            .append(encode(p.email())).append('\t').append(p.visibility()).append('\t').append(String.join(",",p.neverShowTo())).append('\n');
        Path temp = Files.createTempFile(file.getParent(),".user-profiles-",".tmp");
        try {
            Files.setPosixFilePermissions(temp,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            try (FileChannel channel = FileChannel.open(temp,StandardOpenOption.WRITE)) {
                ByteBuffer buffer = StandardCharsets.UTF_8.encode(out.toString());
                while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
            }
            Files.move(temp,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temp); }
    }
    private static String encode(String value) { return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
    private static String decode(String value) throws IOException {
        try { return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(Base64.getDecoder().decode(value))).toString(); }
        catch (IllegalArgumentException | java.nio.charset.CharacterCodingException error) { throw new IOException("Invalid profile encoding",error); }
    }
    static final class InvalidProfile extends IllegalArgumentException { InvalidProfile(String code) { super(code); } }
}
