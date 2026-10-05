package chawe;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class ChatStore {
    record Attachment(String id, String name, String type, long size, String kind) { }
    record Message(long seq, long time, String sender, String text, long revision, long editedAt, boolean deleted, Attachment attachment,String topic) {
        Message(long seq,long time,String sender,String text,long revision,long editedAt,boolean deleted,Attachment attachment) { this(seq,time,sender,text,revision,editedAt,deleted,attachment,"general"); }
        Message(long seq, long time, String sender, String text) { this(seq, time, sender, text, 0, 0, false, null,"general"); }
    }
    record Chat(String peer, String lastText, long lastAt) { }
    record Page(List<Message> messages, boolean more, long revision) { }
    record Changes(List<Message> updates, long revision, boolean more) { }
    private record Change(long revision, long seq, long time, String text, boolean deleted) { }
    static final class ActionException extends Exception {
        final String reason;
        ActionException(String reason) { super(reason); this.reason = reason; }
    }
    private static final int MAX_BYTES = 16_000;
    static final int ARTICLE_BYTES = 262_144;
    static final int ARTICLE_CHARACTERS = 100_000;
    private final Path directory;
    private final Map<String, State> states = new HashMap<>();

    ChatStore(Path dataDirectory) throws IOException {
        directory = dataDirectory.resolve("chats");
        Files.createDirectories(directory);
        Files.setPosixFilePermissions(directory, EnumSet.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        try (DirectoryStream<Path> files = Files.newDirectoryStream(directory, "*.log")) {
            for (Path file : files) {
                String id = file.getFileName().toString();
                if (!validId(id)) throw new IOException("Invalid chat file name");
                truncateIncompleteTail(file);
                State state = new State();
                try (var lines = Files.lines(file, StandardCharsets.UTF_8)) {
                    for (var iterator = lines.iterator(); iterator.hasNext();) {
                        String line = iterator.next();
                        Message message = parse(line);
                        if (message.seq() != state.lastSeq + 1 || !member(id, message.sender()))
                            throw new IOException("Invalid chat history: " + id);
                        state.lastSeq = message.seq();
                        state.last = message;
                        String remarkId = remarkId(line.split("\t", -1));
                        if (remarkId != null && state.remarks.putIfAbsent(remarkId,message.seq()) != null)
                            throw new IOException("Duplicate attachment remark: " + id);
                    }
                }
                states.put(id, state);
                Path changes = directory.resolve(id + ".changes");
                if (Files.exists(changes)) {
                    truncateIncompleteTail(changes);
                    try (var lines = Files.lines(changes, StandardCharsets.UTF_8)) {
                        for (var iterator = lines.iterator(); iterator.hasNext();) {
                            Change change = parseChange(iterator.next());
                            if (change.revision() != state.revision + 1 || change.seq() < 1 || change.seq() > state.lastSeq)
                                throw new IOException("Invalid message change history: " + id);
                            state.revision = change.revision(); state.changes.put(change.seq(), change);
                        }
                    }
                    refreshLast(id, state);
                }
            }
        }
    }

    synchronized Message send(String sender, String recipient, String text) throws IOException {
        return sendAttachment(sender,recipient,text,null);
    }

    synchronized Message sendAttachment(String sender,String recipient,String text,Attachment attachment) throws IOException {
        return sendAttachment(sender,recipient,text,attachment,"general");
    }
    synchronized Message sendAttachment(String sender,String recipient,String text,Attachment attachment,String topic) throws IOException {
        byte[] content = content(text,attachment != null,attachment != null && attachment.kind().equals("article"));
        String id = id(sender, recipient);
        State state = states.computeIfAbsent(id, ignored -> new State());
        if (!topic.equals("general") && (!GroupStore.isPeer(recipient) || !AccountIdentities.validId(topic))) throw new IllegalArgumentException("group_topic_not_found");
        Message message = new Message(state.lastSeq + 1, Instant.now().toEpochMilli(), sender, text,0,0,false,attachment,topic);
        String line = message.seq() + "\t" + message.time() + "\t" + sender + "\t"
            + Base64.getEncoder().encodeToString(content) + (attachment == null ? (GroupStore.isPeer(recipient) ? "\t" : "") : "\t" + encodeAttachment(attachment))
            + (GroupStore.isPeer(recipient) ? "\ttopic:" + topic : "") + "\n";
        append(directory.resolve(id), line);
        state.lastSeq = message.seq();
        state.last = message;
        return message;
    }

    // The link lives in the same durable line as the text. A lost response or
    // a restart cannot turn a retried attachment completion into a second note.
    synchronized Message sendAttachmentRemark(String sender,String recipient,String text,String attachmentId) throws IOException {
        return sendAttachmentRemark(sender,recipient,text,attachmentId,"general");
    }
    synchronized Message sendAttachmentRemark(String sender,String recipient,String text,String attachmentId,String topic) throws IOException {
        byte[] bytes = content(text);
        if (!AccountIdentities.validId(attachmentId)) throw new IllegalArgumentException("invalid_upload_id");
        Message existing = attachmentRemark(sender,recipient,attachmentId);
        if (existing != null) return existing;
        String conversation = id(sender,recipient);
        State state = states.computeIfAbsent(conversation,ignored -> new State());
        if (!topic.equals("general") && !AccountIdentities.validId(topic)) throw new IllegalArgumentException("group_topic_not_found");
        Message message = new Message(state.lastSeq + 1,Instant.now().toEpochMilli(),sender,text,0,0,false,null,topic);
        append(directory.resolve(conversation),message.seq() + "\t" + message.time() + "\t" + sender + "\t"
            + Base64.getEncoder().encodeToString(bytes) + "\tnote:" + attachmentId + (GroupStore.isPeer(recipient) ? "\ttopic:" + topic : "") + "\n");
        state.lastSeq = message.seq(); state.last = message; state.remarks.put(attachmentId,message.seq());
        return message;
    }

    synchronized Message attachmentRemark(String user,String peer,String attachmentId) throws IOException {
        String conversation = id(user,peer); State state = states.get(conversation);
        Long seq = state == null ? null : state.remarks.get(attachmentId);
        if (seq == null) return null;
        try { return requireMessage(conversation,seq); }
        catch (ActionException error) { throw new IOException("Missing attachment remark",error); }
    }

    private static byte[] content(String text) {
        return content(text,false);
    }
    private static byte[] content(String text,boolean allowEmpty) {
        return content(text,allowEmpty,false);
    }
    private static byte[] content(String text,boolean allowEmpty,boolean article) {
        String reason = article ? "invalid_article" : "invalid_message";
        if (text == null || ((!allowEmpty || article) && text.isBlank())
                || text.codePointCount(0,text.length()) > (article ? ARTICLE_CHARACTERS : 4000))
            throw new IllegalArgumentException(reason);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > (article ? ARTICLE_BYTES : MAX_BYTES)) throw new IllegalArgumentException(reason);
        return bytes;
    }

    synchronized Message sendArticle(String sender,String recipient,String markdown,String requestId) throws IOException {
        return sendArticle(sender,recipient,markdown,requestId,"general");
    }
    synchronized Message sendArticle(String sender,String recipient,String markdown,String requestId,String topic) throws IOException {
        byte[] bytes = content(markdown,false,true);
        if (!AccountIdentities.validId(requestId)) throw new IllegalArgumentException("invalid_article");
        Message existing = findAttachment(sender,recipient,requestId);
        if (existing != null) {
            if (!existing.sender().equals(sender) || !existing.attachment().kind().equals("article"))
                throw new IllegalArgumentException("invalid_article");
            // A lost response must never create a second article, even after editing/retraction.
            return existing;
        }
        return sendAttachment(sender,recipient,markdown,
            new Attachment(requestId,articleTitle(markdown),"text/markdown",bytes.length,"article"),topic);
    }

    static String articleTitle(String markdown) {
        String line = markdown.lines().filter(s -> !s.isBlank()).findFirst().orElse("文章").strip()
            .replaceFirst("^#{1,6}\\s+","").replaceAll("[*_`\\[\\]]","").strip();
        if (line.isEmpty()) line = "文章";
        return line.codePointCount(0,line.length()) > 80 ? line.substring(0,line.offsetByCodePoints(0,80)) + "…" : line;
    }

    private static void append(Path file, String line) throws IOException {
        if (Files.exists(file)) truncateIncompleteTail(file);
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                StandardOpenOption.READ)) {
            Files.setPosixFilePermissions(file, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            long size = channel.size(); channel.position(size);
            try {
                ByteBuffer buffer = ByteBuffer.wrap(line.getBytes(StandardCharsets.UTF_8));
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            } catch (IOException error) {
                try { channel.truncate(size); channel.force(true); } catch (IOException rollback) { error.addSuppressed(rollback); }
                throw error;
            }
        }
    }

    synchronized Message edit(String user, String peer, long seq, long expectedRevision, String text)
            throws IOException, ActionException {
        String conversation = id(user, peer);
        Message old = requireMessage(conversation, seq);
        if (text != null && (old.attachment() == null || !old.attachment().kind().equals("article"))) text = text.strip();
        content(text,old.attachment() != null,old.attachment() != null && old.attachment().kind().equals("article"));
        if (!old.sender().equals(user)) throw new ActionException("message_not_yours");
        if (old.attachment()!=null && old.attachment().kind().startsWith("voice")) throw new ActionException("voice_not_editable");
        if (old.deleted()) throw new ActionException("message_retracted");
        if (old.revision() != expectedRevision) throw new ActionException("message_changed");
        if (old.text().equals(text)) return old;
        return change(conversation, old, text, false);
    }

    synchronized Message retract(String user, String peer, long seq) throws IOException, ActionException {
        return retract(user,peer,seq,false);
    }
    synchronized Message retract(String user,String peer,long seq,boolean moderator) throws IOException,ActionException {
        String conversation = id(user, peer);
        Message old = requireMessage(conversation, seq);
        if (!old.sender().equals(user) && !moderator) throw new ActionException("message_not_yours");
        return old.deleted() ? old : change(conversation, old, "", true);
    }

    synchronized Message favorite(String user, String peer, long seq) throws IOException, ActionException {
        Message source = requireMessage(id(user, peer), seq);
        if (source.deleted()) throw new ActionException("message_retracted");
        if (source.attachment()!=null && source.attachment().kind().equals("voice-once")) throw new ActionException("voice_once_only");
        return user.equals(peer) ? source : sendAttachment(user,user,source.text(),source.attachment());
    }

    private Message change(String conversation, Message old, String text, boolean deleted) throws IOException {
        State state = states.get(conversation);
        Change change = new Change(state.revision + 1, old.seq(), Instant.now().toEpochMilli(), text, deleted);
        Message latest = state.last;
        Message updated = new Message(old.seq(), old.time(), old.sender(), text, change.revision(),
            deleted ? 0 : change.time(), deleted,old.attachment(),old.topic());
        if (latest != null && latest.seq() == old.seq()) {
            latest = deleted ? null : updated;
            if (deleted) try (var lines = Files.lines(directory.resolve(conversation), StandardCharsets.UTF_8)) {
                for (var iterator = lines.iterator(); iterator.hasNext();) {
                    Message message = apply(conversation, parse(iterator.next()));
                    if (message.seq() != old.seq() && !message.deleted()) latest = message;
                }
            }
        }
        String line = change.revision() + "\t" + change.seq() + "\t" + change.time() + "\t"
            + (deleted ? "R" : "E") + "\t" + Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)) + "\n";
        append(directory.resolve(conversation + ".changes"), line);
        state.revision = change.revision(); state.changes.put(change.seq(), change);
        state.last = latest;
        return updated;
    }

    synchronized Message notificationMessage(String user,String peer,long seq) throws IOException, ActionException {
        return requireMessage(id(user,peer),seq);
    }

    synchronized Message findAttachment(String user,String peer,String attachment) throws IOException {
        String conversation = id(user,peer); Path file = directory.resolve(conversation);
        if (Files.exists(file)) try (var lines = Files.lines(file,StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = parse(iterator.next());
                if (message.attachment() != null && message.attachment().id().equals(attachment)) return apply(conversation,message);
            }
        }
        return null;
    }

    static String preview(Message message) {
        Attachment a = message.attachment();
        if (a != null && a.kind().equals("article")) return "[文章] " + articleTitle(message.text());
        String label = a == null ? "" : a.kind().startsWith("voice") ? "[语音]" : a.kind().equals("image") ? "[图片]" : a.kind().equals("video") ? "[视频]" : "[文件] " + a.name();
        return label + (label.isEmpty() || message.text().isEmpty() ? "" : " ") + message.text();
    }

    private Message requireMessage(String conversation, long seq) throws IOException, ActionException {
        Path file = directory.resolve(conversation);
        if (Files.exists(file)) try (var lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = parse(iterator.next());
                if (message.seq() == seq) return apply(conversation, message);
                if (message.seq() > seq) break;
            }
        }
        throw new ActionException("message_not_found");
    }

    private Message apply(String conversation, Message message) {
        State state = states.get(conversation);
        Change change = state == null ? null : state.changes.get(message.seq());
        return change == null ? message : new Message(message.seq(), message.time(), message.sender(), change.text(),
            change.revision(), change.deleted() ? 0 : change.time(), change.deleted(),message.attachment(),message.topic());
    }

    private void refreshLast(String conversation, State state) throws IOException {
        state.last = null;
        try (var lines = Files.lines(directory.resolve(conversation), StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = apply(conversation, parse(iterator.next()));
                if (!message.deleted()) state.last = message;
            }
        }
    }

    synchronized Changes changes(String user, String peer, long after, int limit) throws IOException {
        String conversation = id(user, peer);
        State state = states.get(conversation);
        if (state == null) return new Changes(List.of(), 0, false);
        List<Change> changed = state.changes.values().stream().filter(change -> change.revision() > after)
            .sorted(Comparator.comparingLong(Change::revision)).limit(limit + 1L).toList();
        boolean more = changed.size() > limit;
        if (more) changed = changed.subList(0, limit);
        Map<Long, Message> found = new HashMap<>();
        for (Change change : changed) found.put(change.seq(), null);
        if (!found.isEmpty()) try (var lines = Files.lines(directory.resolve(conversation), StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = parse(iterator.next());
                if (found.containsKey(message.seq())) found.put(message.seq(), apply(conversation, message));
            }
        }
        List<Message> updates = new ArrayList<>();
        for (Change change : changed) {
            Message message = found.get(change.seq());
            if (message == null) throw new IOException("Message change target missing");
            updates.add(message);
        }
        return new Changes(updates, more ? changed.get(changed.size() - 1).revision() : state.revision, more);
    }

    synchronized List<Chat> chats(String user, String query) throws IOException {
        String needle = query.toLowerCase(Locale.ROOT);
        List<Chat> result = new ArrayList<>();
        State saved = states.get(id(user, user));
        result.add(new Chat(user, saved == null || saved.last == null ? "" : preview(saved.last),
            saved == null || saved.last == null ? 0 : saved.last.time()));
        for (var entry : states.entrySet()) {
            String name = entry.getKey();
            if (!name.startsWith("dm-")) continue;
            String[] people = people(name);
            if (people == null || entry.getValue().last == null) continue;
            String peer = people[0].equals(user) ? people[1] : people[1].equals(user) ? people[0] : null;
            if (peer != null) result.add(new Chat(peer, preview(entry.getValue().last), entry.getValue().last.time()));
        }
        if (needle.isEmpty()) {
            result.sort(Comparator.comparingLong(Chat::lastAt).reversed());
            return result;
        }
        List<Chat> found = new ArrayList<>();
        for (Chat chat : result) {
            String title = chat.peer().equals(user) ? "收藏夹" : chat.peer();
            if (title.toLowerCase(Locale.ROOT).contains(needle)
                    || chat.lastText().toLowerCase(Locale.ROOT).contains(needle)) {
                found.add(chat);
                continue;
            }
            Message match = lastMatch(id(user, chat.peer()), needle);
            if (match != null) found.add(new Chat(chat.peer(), preview(match), match.time()));
        }
        found.sort(Comparator.comparingLong(Chat::lastAt).reversed());
        return found;
    }

    private Message lastMatch(String conversation, String needle) throws IOException {
        Path file = directory.resolve(conversation);
        if (!Files.exists(file)) return null;
        Message latest = null;
        try (var lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = apply(conversation, parse(iterator.next()));
                if (!message.deleted() && (preview(message).toLowerCase(Locale.ROOT).contains(needle)||message.text().toLowerCase(Locale.ROOT).contains(needle))) latest = message;
            }
        }
        return latest;
    }

    synchronized long lastSequence(String user,String peer) {
        State state = states.get(id(user,peer)); return state == null ? 0 : state.lastSeq;
    }
    synchronized Message lastMessage(String user,String peer) { State state=states.get(id(user,peer));return state==null?null:state.last; }

    synchronized long unreadCount(String user,String peer,long floor,Map<String,Long> through) throws IOException {
        String conversation=id(user,peer);Path file=directory.resolve(conversation);long count=0;
        State state=states.get(conversation);long minimum=through.values().stream().mapToLong(Long::longValue).min().orElse(0);
        if(state==null||state.lastSeq<=Math.max(floor,minimum)||!Files.exists(file))return 0;
        try(var lines=Files.lines(file,StandardCharsets.UTF_8)) {
            for(var iterator=lines.iterator();iterator.hasNext();) {
                Message message=parse(iterator.next());
                if(message.sender().equals(user)||message.seq()<=Math.max(floor,through.getOrDefault(message.topic(),through.getOrDefault("*",0L))))continue;
                if(!apply(conversation,message).deleted())count++;
            }
        }
        return count;
    }
    synchronized List<Message> reactionMessages(String user,String peer,java.util.Set<Long> sequences) throws IOException {
        if(sequences.size()>40||sequences.stream().anyMatch(seq->seq<1))throw new IllegalArgumentException("invalid_reaction");
        String conversation=id(user,peer);Path file=directory.resolve(conversation);
        List<Message> found=new ArrayList<>();if(sequences.isEmpty()||!Files.exists(file))return found;
        try(var lines=Files.lines(file,StandardCharsets.UTF_8)) {
            for(var iterator=lines.iterator();iterator.hasNext();) {
                Message message=parse(iterator.next());if(sequences.contains(message.seq()))found.add(apply(conversation,message));
                if(found.size()==sequences.size())break;
            }
        }
        return found;
    }
    synchronized Page messages(String user, String peer, long before, int limit, String query) throws IOException {
        return messages(user,peer,before,limit,query,null,0);
    }
    synchronized Page messages(String user,String peer,long before,int limit,String query,String topic,long floor) throws IOException {
        String conversation = id(user, peer);
        Path file = directory.resolve(conversation);
        State state = states.get(conversation);
        long revision = state == null ? 0 : state.revision;
        if (!Files.exists(file)) return new Page(List.of(), false, revision);
        String needle = query.toLowerCase(Locale.ROOT);
        ArrayDeque<Message> latest = new ArrayDeque<>();
        try (var lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = apply(conversation, parse(iterator.next()));
                if (message.seq()>floor && (topic==null || message.topic().equals(topic)) && (before == 0 || message.seq() < before)
                        && (needle.isEmpty() || (!message.deleted() && (preview(message).toLowerCase(Locale.ROOT).contains(needle)||message.text().toLowerCase(Locale.ROOT).contains(needle)
                            || (message.attachment() != null && message.attachment().name().toLowerCase(Locale.ROOT).contains(needle)))))) {
                    latest.addLast(message);
                    if (latest.size() > limit + 1) latest.removeFirst();
                }
            }
        }
        boolean more = latest.size() > limit;
        if (more) latest.removeFirst();
        return new Page(new ArrayList<>(latest), more, revision);
    }

    synchronized Page messagesAfter(String user, String peer, long after, int limit) throws IOException {
        return messagesAfter(user,peer,after,limit,null);
    }
    synchronized Page messagesAfter(String user,String peer,long after,int limit,String topic) throws IOException {
        String conversation = id(user, peer);
        State state = states.get(conversation);
        if (state == null || after >= state.lastSeq) return new Page(List.of(), false, state == null ? 0 : state.revision);
        Path file = directory.resolve(conversation);
        List<Message> result = new ArrayList<>();
        try (var lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (var iterator = lines.iterator(); iterator.hasNext();) {
                Message message = apply(conversation, parse(iterator.next()));
                if (message.seq() > after && (topic==null || message.topic().equals(topic))) {
                    result.add(message);
                    if (result.size() > limit) break;
                }
            }
        }
        boolean more = result.size() > limit;
        if (more) result.remove(result.size() - 1);
        return new Page(result, more, state.revision);
    }

    private static String id(String a, String b) {
        if (AccountStore.validUsername(a) && GroupStore.isPeer(b)) return "group-" + b.substring(6) + ".log";
        if (!AccountStore.validUsername(a) || !AccountStore.validUsername(b))
            throw new IllegalArgumentException("invalid_user");
        if (a.equals(b)) return "self-" + a + ".log";
        return a.compareTo(b) < 0 ? "dm-" + a + "-" + b + ".log" : "dm-" + b + "-" + a + ".log";
    }

    private static boolean validId(String id) {
        if (id.matches("group-[a-f0-9]{32}\\.log")) return true;
        if (id.startsWith("self-") && id.endsWith(".log"))
            return AccountStore.validUsername(id.substring(5, id.length() - 4));
        return people(id) != null;
    }

    private static String[] people(String id) {
        if (!id.startsWith("dm-") || !id.endsWith(".log")) return null;
        String body = id.substring(3, id.length() - 4);
        int split = body.indexOf('-');
        if (split < 0) return null;
        String a = body.substring(0, split), b = body.substring(split + 1);
        return AccountStore.validUsername(a) && AccountStore.validUsername(b) && a.compareTo(b) < 0
            ? new String[]{a, b} : null;
    }

    private static boolean member(String id, String sender) {
        if (id.matches("group-[a-f0-9]{32}\\.log")) return validSender(sender);
        if (id.startsWith("self-")) return id.equals("self-" + sender + ".log");
        String[] people = people(id);
        return people != null && (people[0].equals(sender) || people[1].equals(sender));
    }

    // The full identity makes this marker longer than any registrable username.
    private static boolean validSender(String sender) {
        return AccountStore.validUsername(sender) || sender != null && sender.matches("__deleted_[a-f0-9]{32}");
    }
    private static Message parse(String line) throws IOException {
        try {
            String[] parts = line.split("\t", -1);
            if ((parts.length != 4 && parts.length != 5 && parts.length != 6) || !validSender(parts[2])) throw new IllegalArgumentException();
            byte[] text = Base64.getDecoder().decode(parts[3]);
            Attachment attachment = parts.length >= 5 && !parts[4].isEmpty() && remarkId(parts) == null ? decodeAttachment(parts[4]) : null;
            String topic = parts.length == 6 && parts[5].startsWith("topic:") ? parts[5].substring(6) : "general";
            if (parts.length==6 && (!parts[5].startsWith("topic:") || !topic.equals("general") && !AccountIdentities.validId(topic))) throw new IllegalArgumentException();
            if (text.length > (attachment != null && attachment.kind().equals("article") ? ARTICLE_BYTES : MAX_BYTES)) throw new IllegalArgumentException();
            return new Message(Long.parseLong(parts[0]), Long.parseLong(parts[1]), parts[2],
                StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(text)).toString(),0,0,false,
                attachment,topic);
        } catch (Exception e) {
            throw new IOException("Invalid chat record", e);
        }
    }

    private static String remarkId(String[] fields) throws IOException {
        if (fields.length < 5 || !fields[4].startsWith("note:")) return null;
        String id = fields[4].substring(5);
        if (!AccountIdentities.validId(id)) throw new IOException("Invalid attachment remark link");
        return id;
    }

    private static Change parseChange(String line) throws IOException {
        try {
            String[] parts = line.split("\t", -1);
            if (parts.length != 5 || !(parts[3].equals("E") || parts[3].equals("R"))) throw new IllegalArgumentException();
            byte[] bytes = Base64.getDecoder().decode(parts[4]);
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            boolean deleted = parts[3].equals("R");
            if (deleted && !text.isEmpty()) throw new IllegalArgumentException();
            if (!deleted && (bytes.length > ARTICLE_BYTES || text.codePointCount(0,text.length()) > ARTICLE_CHARACTERS)) throw new IllegalArgumentException();
            long revision = Long.parseLong(parts[0]), seq = Long.parseLong(parts[1]), time = Long.parseLong(parts[2]);
            if (revision < 1 || seq < 1 || time < 1) throw new IllegalArgumentException();
            return new Change(revision, seq, time, text, deleted);
        } catch (Exception error) { throw new IOException("Invalid message change record", error); }
    }

    private static void truncateIncompleteTail(Path file) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, StandardOpenOption.WRITE)) {
            long size = channel.size();
            if (size == 0) return;
            ByteBuffer one = ByteBuffer.allocate(1);
            channel.read(one, size - 1);
            if (one.array()[0] == '\n') return;
            long position = size - 1;
            while (position > 0) {
                one.clear();
                channel.read(one, --position);
                if (one.array()[0] == '\n') { channel.truncate(position + 1); channel.force(true); return; }
            }
            channel.truncate(0);
            channel.force(true);
        }
    }

    private static String encodeAttachment(Attachment a) {
        return a.id() + "|" + a.type() + "|" + a.size() + "|" + a.kind() + "|"
            + Base64.getEncoder().encodeToString(a.name().getBytes(StandardCharsets.UTF_8));
    }
    private static Attachment decodeAttachment(String value) throws IOException {
        String[] f = value.split("\\|",-1);
        if (f.length != 5 || !AccountIdentities.validId(f[0]) || !f[1].matches("[a-z0-9.+-]+/[a-z0-9.+-]+")
            || !List.of("image","video","file","voice","voice-once","article").contains(f[3])) throw new IOException("Invalid attachment record");
        long size = Long.parseLong(f[2]);
        String name = new String(Base64.getDecoder().decode(f[4]),StandardCharsets.UTF_8);
        if (f[3].equals("article") && (!f[1].equals("text/markdown") || size > ARTICLE_BYTES)) throw new IOException("Invalid article metadata");
        if (size < 1 || (!f[3].startsWith("voice") && size > Attachments.MAX_FILE) || size>9007199254740991L || name.isEmpty() || name.length() > 512) throw new IOException("Invalid attachment metadata");
        return new Attachment(f[0],name,f[1],size,f[3]);
    }

    private static final class State {
        long lastSeq;
        Message last;
        long revision;
        final Map<Long, Change> changes = new HashMap<>();
        final Map<String, Long> remarks = new HashMap<>();
    }
}
