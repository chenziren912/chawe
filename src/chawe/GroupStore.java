package chawe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.*;

/** Group membership uses immutable account IDs; private contacts are never group members implicitly. */
final class GroupStore {
    static final Set<String> PERMISSIONS = Set.of("text","photos","videos","files","voice","articles","addMembers","changeInfo","topics","pinMessages");
    static final Set<String> ADMIN_RIGHTS = Set.of("changeInfo","deleteMessages","inviteUsers","banUsers","manageTopics","pinMessages");
    static final List<String> EMOJI = List.of("👍","❤️","😂","🔥","🎉","👏","😍","🤔","👎","😢","😮","💯");
    record Member(String id,String role,Set<String> rights,long joined,long floor) { }
    record Invite(String token,String creator,long created,long expires,int limit,int used,boolean revoked) { }
    record Topic(String id,String title,boolean closed) { }
    static final class Group {
        final String id;
        String owner,name,description="",handle="",type="private",avatar="",reactionMode="all";
        long version=1,created;
        boolean deleted,history=true,topicsEnabled;
        Set<String> permissions=new HashSet<>(PERMISSIONS),allowedReactions=new HashSet<>(EMOJI);
        Map<String,Member> members=new LinkedHashMap<>();
        Map<String,Invite> invites=new LinkedHashMap<>();
        Map<String,Topic> topics=new LinkedHashMap<>();
        Map<Long,Map<String,String>> reactions=new HashMap<>();
        Map<String,String> uploadTopics=new HashMap<>();
        Group(String id) { this.id=id; }
        Group(Group before) {
            id=before.id;owner=before.owner;name=before.name;description=before.description;handle=before.handle;type=before.type;avatar=before.avatar;
            reactionMode=before.reactionMode;version=before.version;created=before.created;deleted=before.deleted;history=before.history;topicsEnabled=before.topicsEnabled;
            permissions=new HashSet<>(before.permissions);allowedReactions=new HashSet<>(before.allowedReactions);
            members=new LinkedHashMap<>(before.members);invites=new LinkedHashMap<>(before.invites);topics=new LinkedHashMap<>(before.topics);
            before.reactions.forEach((seq,values)->reactions.put(seq,new HashMap<>(values)));uploadTopics=new HashMap<>(before.uploadTopics);
        }
    }
    private final Path index,avatarDirectory;
    private Map<String,Group> groups=new LinkedHashMap<>();
    GroupStore(Path data) throws IOException {
        index=data.resolve("groups-v1.tsv");avatarDirectory=data.resolve("group-avatars");Files.createDirectories(avatarDirectory);
        Files.setPosixFilePermissions(avatarDirectory,EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.OWNER_EXECUTE));
        if(!Files.exists(index))return;
        List<String> lines=Files.readAllLines(index,StandardCharsets.UTF_8);
        if(lines.isEmpty()||!lines.get(0).equals("# chawe-groups-v1"))throw new IOException("Invalid group index");
        for(String line:lines.subList(1,lines.size()))try {
            String[] f=line.split("\t",-1);if(f.length!=2||!AccountIdentities.validId(f[0]))throw new IllegalArgumentException();
            Group g=decode(f[0],Base64.getDecoder().decode(f[1]));validate(g);
            if(groups.putIfAbsent(g.id,g)!=null)throw new IllegalArgumentException();
            if(!g.avatar.isEmpty()&&!Files.isRegularFile(avatarPath(g.avatar)))throw new IOException("Missing group avatar");
        }catch(RuntimeException error){throw new IOException("Invalid group record",error);}
    }
    static boolean isPeer(String peer){return peer!=null&&peer.startsWith("group:")&&AccountIdentities.validId(peer.substring(6));}
    static String peer(String id){if(!AccountIdentities.validId(id))throw new IllegalArgumentException("group_not_found");return "group:"+id;}
    synchronized boolean exists(String id){return groups.containsKey(id);}
    synchronized Group get(String id){Group g=groups.get(id);if(g==null||g.deleted)throw new IllegalArgumentException("group_not_found");return new Group(g);}
    synchronized Group member(String id,String user){Group g=get(id);if(!g.members.containsKey(user))throw new IllegalArgumentException("group_not_member");return g;}
    synchronized List<Group> list(String user,String query,boolean global){
        String needle=query.replaceFirst("^@","").toLowerCase(Locale.ROOT);
        return groups.values().stream().filter(g->!g.deleted&&(global?g.type.equals("public"):g.members.containsKey(user)))
            .filter(g->needle.isEmpty()||g.name.toLowerCase(Locale.ROOT).contains(needle)||g.handle.toLowerCase(Locale.ROOT).contains(needle))
            .map(Group::new).toList();
    }
    static boolean manages(Group g,String user,String right){Member m=g.members.get(user);return m!=null&&(m.role.equals("owner")||m.role.equals("admin")&&m.rights.contains(right));}
    static boolean permits(Group g,String user,String permission){Member m=g.members.get(user);if(m==null)return false;if(m.role.equals("owner")||g.permissions.contains(permission))return true;
        String right=switch(permission){case "changeInfo"->"changeInfo";case "addMembers"->"inviteUsers";case "topics"->"manageTopics";case "pinMessages"->"pinMessages";default->null;};
        return m.role.equals("admin")&&(right==null||m.rights.contains(right));}
    synchronized void checkSend(String id,String user,String kind,String topic){
        Group g=member(id,user);String permission=switch(kind){case "image"->"photos";case "video"->"videos";case "file"->"files";case "voice","voice-once"->"voice";case "article"->"articles";default->"text";};
        if(!permits(g,user,permission))throw new IllegalArgumentException("group_permission_denied");
        Topic t=g.topics.get(topic);if(t==null||!topic.equals("general")&&!g.topicsEnabled)throw new IllegalArgumentException("group_topic_not_found");
        if(t.closed&&!manages(g,user,"manageTopics"))throw new IllegalArgumentException("group_topic_closed");
    }
    synchronized Group create(String id,String owner,String name,List<String> members) throws IOException {
        if(!AccountIdentities.validId(id))throw new IllegalArgumentException("invalid_group");
        if(groups.containsKey(id)){Group old=get(id);if(!old.owner.equals(owner))throw new IllegalArgumentException("invalid_group");return old;}
        Group g=new Group(id);g.owner=owner;g.name=name.strip();g.created=Instant.now().toEpochMilli();
        g.members.put(owner,new Member(owner,"owner",Set.copyOf(ADMIN_RIGHTS),g.created,0));
        for(String user:members)g.members.putIfAbsent(user,new Member(user,"member",Set.of(),g.created,0));
        if(g.members.size()<2)throw new IllegalArgumentException("group_members_required");
        g.topics.put("general",new Topic("general","常规",false));
        String token=UUID.randomUUID().toString().replace("-","");g.invites.put(token,new Invite(token,owner,g.created,0,0,0,false));
        validate(g);commit(g);return new Group(g);
    }
    synchronized Group save(String id,String user,long version,Map<String,String> fields) throws IOException {
        Group g=member(id,user);if(fields.keySet().stream().anyMatch(k->Set.of("type","permissions","history","topicsEnabled","reactionMode").contains(k)))requireRight(g,user,"changeInfo");
        else if(!permits(g,user,"changeInfo"))throw new IllegalArgumentException("group_permission_denied");requireVersion(g,version);
        if(fields.containsKey("name"))g.name=fields.get("name").strip();
        if(fields.containsKey("description"))g.description=fields.get("description").strip();
        if(fields.containsKey("type")){
            if(!g.owner.equals(user))throw new IllegalArgumentException("group_owner_required");
            g.type=fields.get("type");g.handle=g.type.equals("public")?fields.getOrDefault("handle","").toLowerCase(Locale.ROOT).strip():"";
            if(g.type.equals("public"))for(Group other:groups.values())if(!other.deleted&&!other.id.equals(id)&&other.handle.equals(g.handle))throw new IllegalArgumentException("group_handle_taken");
        }
        if(fields.containsKey("permissions")){if(!g.owner.equals(user))throw new IllegalArgumentException("group_owner_required");g.permissions=csv(fields.get("permissions"));}
        if(fields.containsKey("history"))g.history=bool(fields.get("history"));
        if(fields.containsKey("topicsEnabled"))g.topicsEnabled=bool(fields.get("topicsEnabled"));
        if(fields.containsKey("reactionMode")){g.reactionMode=fields.get("reactionMode");g.allowedReactions=csv(fields.getOrDefault("allowedReactions",String.join(",",EMOJI)));}
        validate(g);g.version++;commit(g);return g;
    }
    synchronized Group add(String id,String actor,List<String> members,long lastSequence) throws IOException {
        Group g=member(id,actor);if(!manages(g,actor,"inviteUsers")&&!permits(g,actor,"addMembers"))throw new IllegalArgumentException("group_permission_denied");
        long now=Instant.now().toEpochMilli();for(String user:members)g.members.putIfAbsent(user,new Member(user,"member",Set.of(),now,g.history?0:Math.max(0,lastSequence-100)));
        validate(g);g.version++;commit(g);return g;
    }
    synchronized Group role(String id,String actor,String user,String role,Set<String> rights) throws IOException {
        Group g=member(id,actor);if(!g.owner.equals(actor))throw new IllegalArgumentException("group_owner_required");
        if(user.equals(g.owner)||!g.members.containsKey(user)||!Set.of("owner","admin","member").contains(role)||!ADMIN_RIGHTS.containsAll(rights))throw new IllegalArgumentException("invalid_group_member");
        if(role.equals("owner")){Member old=g.members.get(actor);g.members.put(actor,new Member(actor,"admin",Set.copyOf(ADMIN_RIGHTS),old.joined,old.floor));g.owner=user;rights=ADMIN_RIGHTS;}
        Member before=g.members.get(user);g.members.put(user,new Member(user,role,!role.equals("member")?Set.copyOf(rights):Set.of(),before.joined,before.floor));
        g.version++;commit(g);return g;
    }
    synchronized Group remove(String id,String actor,String user) throws IOException {
        Group g=member(id,actor);
        if(!actor.equals(user))requireRight(g,actor,"banUsers");
        if(user.equals(g.owner))throw new IllegalArgumentException("group_owner_required");
        Member target=g.members.get(user);if(target==null)throw new IllegalArgumentException("invalid_group_member");
        if(!actor.equals(user)&&target.role.equals("admin")&&!g.owner.equals(actor))throw new IllegalArgumentException("group_owner_required");
        g.members.remove(user);g.version++;commit(g);return g;
    }
    synchronized void delete(String id,String actor) throws IOException {Group g=member(id,actor);if(!g.owner.equals(actor))throw new IllegalArgumentException("group_owner_required");g.deleted=true;g.version++;commit(g);}
    synchronized Group invite(String id,String actor,String revoke,long expires,int limit) throws IOException {
        Group g=member(id,actor);requireRight(g,actor,"inviteUsers");
        if(revoke!=null){Invite old=g.invites.get(revoke);if(old==null)throw new IllegalArgumentException("group_invite_invalid");g.invites.put(revoke,new Invite(old.token,old.creator,old.created,old.expires,old.limit,old.used,true));}
        else {if(expires<0||limit<0||limit>100000||g.invites.values().stream().filter(i->!i.revoked).count()>=20)throw new IllegalArgumentException("group_invite_limit");
            String token=UUID.randomUUID().toString().replace("-","");long now=Instant.now().toEpochMilli();g.invites.put(token,new Invite(token,actor,now,expires,limit,0,false));}
        g.version++;commit(g);return g;
    }
    private static long inviteExpiry(int days) {
        if(days<0||days>3650)throw new IllegalArgumentException("group_invite_settings_invalid");
        return days==0?0:Instant.now().toEpochMilli()+days*86400000L;
    }
    synchronized Group createInvite(String id,String actor,int days,int limit) throws IOException {
        return invite(id,actor,null,inviteExpiry(days),limit);
    }
    synchronized Group editInvite(String id,String actor,String token,long expectedExpires,int expectedLimit,Integer days,int limit) throws IOException {
        Group g=member(id,actor);requireRight(g,actor,"inviteUsers");Invite old=g.invites.get(token);
        if(old==null||old.revoked)throw new IllegalArgumentException("group_invite_invalid");
        if(old.expires!=expectedExpires||old.limit!=expectedLimit)throw new IllegalArgumentException("group_invite_changed");
        if(limit<0||limit>100000)throw new IllegalArgumentException("group_invite_settings_invalid");
        if(limit>0&&limit<old.used)throw new IllegalArgumentException("group_invite_limit_below_used");
        long expires=days==null?old.expires:inviteExpiry(days);
        // Keep the token and its live usage count, including joins made while the editor was open.
        g.invites.put(token,new Invite(old.token,old.creator,old.created,expires,limit,old.used,false));
        g.version++;commit(g);return g;
    }
    synchronized Group resolveInvite(String token){
        long now=Instant.now().toEpochMilli();for(Group g:groups.values()){Invite i=g.invites.get(token);if(!g.deleted&&i!=null&&!i.revoked&&(i.expires==0||i.expires>now)&&(i.limit==0||i.used<i.limit))return new Group(g);}
        throw new IllegalArgumentException("group_invite_invalid");
    }
    synchronized Group join(String user,String id,String token,long lastSequence) throws IOException {
        Group g=token==null||token.isBlank()?get(id):resolveInvite(token);
        if(!g.id.equals(id))throw new IllegalArgumentException("group_invite_invalid");
        if(g.members.containsKey(user))return g;
        if(g.type.equals("private")&&(token==null||!g.invites.containsKey(token)))throw new IllegalArgumentException("group_invite_invalid");
        g.members.put(user,new Member(user,"member",Set.of(),Instant.now().toEpochMilli(),g.history?0:Math.max(0,lastSequence-100)));
        if(token!=null&&g.invites.containsKey(token)){Invite old=g.invites.get(token);g.invites.put(token,new Invite(old.token,old.creator,old.created,old.expires,old.limit,old.used+1,old.revoked));}
        validate(g);g.version++;commit(g);return g;
    }
    synchronized Group topic(String id,String actor,String topicId,String title,boolean closed) throws IOException {
        Group g=member(id,actor);if(!manages(g,actor,"manageTopics")&&!permits(g,actor,"topics"))throw new IllegalArgumentException("group_permission_denied");
        if(!g.topicsEnabled||(!topicId.equals("general")&&!AccountIdentities.validId(topicId)))throw new IllegalArgumentException("group_topic_not_found");
        if(g.topics.containsKey(topicId)&&!manages(g,actor,"manageTopics"))throw new IllegalArgumentException("group_permission_denied");
        if(g.topics.size()>=200&&!g.topics.containsKey(topicId))throw new IllegalArgumentException("group_topic_limit");
        g.topics.put(topicId,new Topic(topicId,title.strip(),closed));validate(g);g.version++;commit(g);return g;
    }
    synchronized void react(String id,String actor,long seq,String emoji) throws IOException {
        Group g=member(id,actor);if(g.reactionMode.equals("none")||!EMOJI.contains(emoji)||g.reactionMode.equals("selected")&&!g.allowedReactions.contains(emoji))throw new IllegalArgumentException("group_reaction_disabled");
        Map<String,String> values=g.reactions.computeIfAbsent(seq,k->new HashMap<>());
        if(emoji.equals(values.get(actor)))values.remove(actor);else values.put(actor,emoji);
        if(values.isEmpty())g.reactions.remove(seq);commit(g);
    }
    synchronized void uploadTopic(String id,String upload,String topic) throws IOException {
        Group g=get(id);if(!AccountIdentities.validId(upload)||!g.topics.containsKey(topic))throw new IllegalArgumentException("group_topic_not_found");
        String previous=g.uploadTopics.putIfAbsent(upload,topic);if(previous!=null&&!previous.equals(topic))throw new IllegalArgumentException("invalid_upload_id");
        if(previous==null)commit(g);
    }
    synchronized String uploadTopic(String id,String upload){return get(id).uploadTopics.getOrDefault(upload,"general");}
    synchronized Group avatar(String id,String actor,long version,byte[] input) throws IOException {
        Group g=member(id,actor);if(!permits(g,actor,"changeInfo"))throw new IllegalArgumentException("group_permission_denied");requireVersion(g,version);
        if(input==null)g.avatar="";else {
            byte[] canonical=Avatars.normalize(input);String hash;
            try{hash=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(canonical));}catch(java.security.NoSuchAlgorithmException error){throw new IllegalStateException(error);}
            if(!Files.exists(avatarPath(hash)))RenameTransaction.atomicWrite(avatarPath(hash),canonical);g.avatar=hash;
        }
        g.version++;commit(g);return g;
    }
    synchronized byte[] avatarBytes(String id,String user) throws IOException {Group g=get(id);if(!g.type.equals("public")&&!g.members.containsKey(user))throw new IllegalArgumentException("group_not_member");return g.avatar.isEmpty()?null:Files.readAllBytes(avatarPath(g.avatar));}
    private Path avatarPath(String hash){if(!hash.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("invalid_group");return avatarDirectory.resolve(hash+".png");}
    private static void requireRight(Group g,String user,String right){if(!manages(g,user,right))throw new IllegalArgumentException("group_permission_denied");}
    private static void requireVersion(Group g,long version){if(g.version!=version)throw new IllegalArgumentException("group_changed");}
    private static Set<String> csv(String value){return value==null||value.isEmpty()?new HashSet<>():new HashSet<>(Arrays.asList(value.split(",",-1)));}
    private static boolean bool(String value){if(!Set.of("true","false").contains(value))throw new IllegalArgumentException("invalid_group");return value.equals("true");}
    private static void validate(Group g){
        if(!AccountIdentities.validId(g.id)||!AccountIdentities.validId(g.owner)||g.name==null||g.name.isBlank()||g.name.chars().anyMatch(c->c<32||c==127)||g.name.codePointCount(0,g.name.length())>128||g.description.codePointCount(0,g.description.length())>255
            ||!Set.of("private","public").contains(g.type)||g.type.equals("public")&&!g.handle.matches("[a-z][a-z0-9_]{4,31}")||!Set.of("all","selected","none").contains(g.reactionMode)
            ||!PERMISSIONS.containsAll(g.permissions)||!new HashSet<>(EMOJI).containsAll(g.allowedReactions)||g.members.size()>1000||g.version<1||g.created<1)throw new IllegalArgumentException("invalid_group");
        Member owner=g.members.get(g.owner);if(owner==null||!owner.role.equals("owner"))throw new IllegalArgumentException("invalid_group");
        for(Member m:g.members.values())if(!AccountIdentities.validId(m.id)||!Set.of("owner","admin","member").contains(m.role)||!ADMIN_RIGHTS.containsAll(m.rights)||m.floor<0||m.joined<1||m.role.equals("owner")&&!m.id.equals(g.owner))throw new IllegalArgumentException("invalid_group_member");
        for(Topic t:g.topics.values())if(!t.id.equals("general")&&!AccountIdentities.validId(t.id)||t.title.isBlank()||t.title.codePointCount(0,t.title.length())>80)throw new IllegalArgumentException("invalid_group_topic");
        if(!g.topics.containsKey("general")||!g.avatar.isEmpty()&&!g.avatar.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("invalid_group");
        for(Invite i:g.invites.values())if(!AccountIdentities.validId(i.token)||!AccountIdentities.validId(i.creator)||i.created<1||i.expires<0||i.limit<0||i.used<0)throw new IllegalArgumentException("invalid_group");
        for(var e:g.reactions.entrySet())if(e.getKey()<1)throw new IllegalArgumentException("invalid_group");
    }
    private void commit(Group g) throws IOException {
        Map<String,Group> updated=new LinkedHashMap<>(groups);updated.put(g.id,new Group(g));StringBuilder out=new StringBuilder("# chawe-groups-v1\n");
        for(Group item:updated.values())out.append(item.id).append('\t').append(Base64.getEncoder().encodeToString(encode(item))).append('\n');
        RenameTransaction.atomicWrite(index,out.toString().getBytes(StandardCharsets.UTF_8));groups=updated;
    }
    private static byte[] encode(Group g) throws IOException {
        Properties p=new Properties();p.setProperty("owner",g.owner);p.setProperty("name",g.name);p.setProperty("description",g.description);p.setProperty("type",g.type);p.setProperty("handle",g.handle);p.setProperty("avatar",g.avatar);
        p.setProperty("version",Long.toString(g.version));p.setProperty("created",Long.toString(g.created));p.setProperty("deleted",Boolean.toString(g.deleted));p.setProperty("history",Boolean.toString(g.history));p.setProperty("topicsEnabled",Boolean.toString(g.topicsEnabled));
        p.setProperty("permissions",String.join(",",g.permissions));p.setProperty("reactionMode",g.reactionMode);p.setProperty("allowedReactions",String.join(",",g.allowedReactions));
        for(Member m:g.members.values())p.setProperty("member."+m.id,m.role+"|"+String.join(",",m.rights)+"|"+m.joined+"|"+m.floor);
        for(Invite i:g.invites.values())p.setProperty("invite."+i.token,i.creator+"|"+i.created+"|"+i.expires+"|"+i.limit+"|"+i.used+"|"+i.revoked);
        for(Topic t:g.topics.values())p.setProperty("topic."+t.id,Boolean.toString(t.closed)+"|"+t.title);
        for(var e:g.reactions.entrySet())for(var v:e.getValue().entrySet())p.setProperty("reaction."+e.getKey()+"."+v.getKey(),v.getValue());
        g.uploadTopics.forEach((id,topic)->p.setProperty("upload."+id,topic));ByteArrayOutputStream out=new ByteArrayOutputStream();p.store(out,null);return out.toByteArray();
    }
    private static Group decode(String id,byte[] bytes) throws IOException {
        Properties p=new Properties();p.load(new ByteArrayInputStream(bytes));Group g=new Group(id);
        g.owner=p.getProperty("owner");g.name=p.getProperty("name");g.description=p.getProperty("description","");g.type=p.getProperty("type");g.handle=p.getProperty("handle","");g.avatar=p.getProperty("avatar","");
        g.version=Long.parseLong(p.getProperty("version"));g.created=Long.parseLong(p.getProperty("created"));g.deleted=bool(p.getProperty("deleted"));g.history=bool(p.getProperty("history"));g.topicsEnabled=bool(p.getProperty("topicsEnabled"));
        g.permissions=csv(p.getProperty("permissions"));g.reactionMode=p.getProperty("reactionMode");g.allowedReactions=csv(p.getProperty("allowedReactions"));
        for(String key:p.stringPropertyNames()){
            String value=p.getProperty(key);String[] f=value.split("\\|",-1);
            if(key.startsWith("member.")){String user=key.substring(7);g.members.put(user,new Member(user,f[0],Set.copyOf(csv(f[1])),Long.parseLong(f[2]),Long.parseLong(f[3])));}
            else if(key.startsWith("invite.")){String token=key.substring(7);if(!AccountIdentities.validId(token)||f.length!=6)throw new IllegalArgumentException();g.invites.put(token,new Invite(token,f[0],Long.parseLong(f[1]),Long.parseLong(f[2]),Integer.parseInt(f[3]),Integer.parseInt(f[4]),bool(f[5])));}
            else if(key.startsWith("topic.")){String topic=key.substring(6);int split=value.indexOf('|');g.topics.put(topic,new Topic(topic,value.substring(split+1),bool(value.substring(0,split))));}
            else if(key.startsWith("reaction.")){String[] parts=key.split("\\.");if(parts.length!=3||!AccountIdentities.validId(parts[2])||!EMOJI.contains(value))throw new IllegalArgumentException();g.reactions.computeIfAbsent(Long.parseLong(parts[1]),seq->new HashMap<>()).put(parts[2],value);}
            else if(key.startsWith("upload.")){if(!AccountIdentities.validId(key.substring(7)))throw new IllegalArgumentException();g.uploadTopics.put(key.substring(7),value);}
        }
        return g;
    }
}
