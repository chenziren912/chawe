package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

/** Browser grants, subscriptions and a bounded durable outbox use stable account identities. */
final class PushNotifications {
    record Preference(boolean confirmed,boolean enabled,boolean preview) { }
    record Subscription(String browser,String fingerprint,String endpoint,String key,String auth) { }
    record Event(String id,String browser,String subscription,String recipient,String sender,long seq,long created,int attempts,long next) { }
    private record Delivery(long pushed,long shown,String covered,String pending,long pendingAt) { }
    private static final long INTERVAL=15_000;
    private final Path directory;
    final WebPushTransport transport;
    private Map<String,Preference> preferences = new LinkedHashMap<>();
    private Map<String,Subscription> subscriptions = new LinkedHashMap<>();
    private Map<String,Event> events = new LinkedHashMap<>();
    private Map<String,Delivery> deliveries = new LinkedHashMap<>();
    private final Map<String,Integer> deliveryStatus = new HashMap<>();
    PushNotifications(Path directory) throws IOException {
        this.directory = directory; transport = new WebPushTransport(directory);
        try {
            for (String[] f : rows("push-preferences-v1.tsv","# chawe-push-preferences-v1")) {
                if (f.length != 5 || !hash(f[0]) || !AccountIdentities.validId(f[1])) throw new IllegalArgumentException();
                if (preferences.putIfAbsent(f[0]+":"+f[1],new Preference(flag(f[2]),flag(f[3]),flag(f[4]))) != null) throw new IllegalArgumentException();
            }
            for (String[] f : rows("push-subscriptions-v1.tsv","# chawe-push-subscriptions-v1")) {
                if (f.length != 5 || !hash(f[0]) || !hash(f[1])) throw new IllegalArgumentException();
                String endpoint = new String(Base64.getDecoder().decode(f[2]),StandardCharsets.UTF_8); WebPushTransport.validate(endpoint,f[3],f[4]);
                if (!fingerprint(endpoint).equals(f[1]) || subscriptions.putIfAbsent(f[0],new Subscription(f[0],f[1],endpoint,f[3],f[4])) != null) throw new IllegalArgumentException();
            }
            for (String[] f : rows("push-outbox-v1.tsv","# chawe-push-outbox-v1")) {
                if (f.length != 9 || !AccountIdentities.validId(f[0]) || !hash(f[1]) || !hash(f[2]) || !AccountIdentities.validId(f[3]) || !AccountIdentities.validId(f[4])) throw new IllegalArgumentException();
                Event event = new Event(f[0],f[1],f[2],f[3],f[4],Long.parseLong(f[5]),Long.parseLong(f[6]),Integer.parseInt(f[7]),Long.parseLong(f[8]));
                if (event.seq() <= 0 || event.created() <= 0 || event.attempts() < 0 || event.attempts() > 6 || event.next() < 0) throw new IllegalArgumentException();
                if (event.created() > now()-86400 && events.putIfAbsent(event.id(),event) != null) throw new IllegalArgumentException();
            }
            for(String[] f:rows("push-delivery-v1.tsv","# chawe-push-delivery-v1")) {
                if(f.length!=6||!hash(f[0])||!f[3].isEmpty()&&!AccountIdentities.validId(f[3])||!f[4].isEmpty()&&!AccountIdentities.validId(f[4]))throw new IllegalArgumentException();
                Delivery value=new Delivery(Long.parseLong(f[1]),Long.parseLong(f[2]),f[3],f[4],Long.parseLong(f[5]));
                if(value.pushed()<0||value.shown()<0||value.pendingAt()<0||value.pending().isEmpty()&&value.pendingAt()!=0||deliveries.putIfAbsent(f[0],value)!=null)throw new IllegalArgumentException();
            }
            if (preferences.size() > 5000 || subscriptions.size() > 1000 || events.size() > 5000 || deliveries.size()>5000) throw new IllegalArgumentException();
        } catch (IllegalArgumentException error) { throw new IOException("Invalid push data",error); }
    }
    synchronized Preference preference(String browser,String id) { return preferences.getOrDefault(browser+":"+id,new Preference(false,false,true)); }
    synchronized boolean subscribed(String browser) { return subscriptions.containsKey(browser); }
    synchronized int deliveryStatus(String browser) { return deliveryStatus.getOrDefault(browser,0); }
    synchronized List<String> enabledAccounts(String browser){return preferences.entrySet().stream().filter(e->e.getKey().startsWith(browser+":")&&e.getValue().enabled()).map(e->e.getKey().substring(browser.length()+1)).toList();}
    private Delivery delivery(String browser){return deliveries.getOrDefault(browser,new Delivery(0,0,"","",0));}
    private boolean covered(Event event){
        Delivery d=delivery(event.browser());if(d.covered().isEmpty())return false;
        if(!events.containsKey(d.covered()))return event.created()*1000+999<d.shown();
        boolean past=false;for(var item:events.values())if(item.browser().equals(event.browser())){
            if(item.id().equals(event.id()))return !past;
            if(item.id().equals(d.covered()))past=true;
        }
        return false;
    }
    synchronized List<Event> recent(String browser,long since) {
        Delivery d=delivery(browser);
        return events.values().stream().filter(e -> e.browser().equals(browser) && e.created()>now()-3600 && !covered(e)
            && (e.created()>=since||e.id().equals(d.pending())&&d.pendingAt()<=System.currentTimeMillis())
            && preference(browser,e.recipient()).enabled()).toList();
    }
    synchronized void subscribe(String browser,String endpoint,String key,String auth) throws IOException {
            WebPushTransport.validate(endpoint,key,auth); Map<String,Subscription> updated = new LinkedHashMap<>(subscriptions);
            String fp = fingerprint(endpoint); updated.entrySet().removeIf(entry -> entry.getValue().fingerprint().equals(fp));
            updated.put(browser,new Subscription(browser,fp,endpoint,key,auth));
            if (updated.size() > 1000) throw new IllegalArgumentException("push_capacity_reached");
            persistSubscriptions(updated); subscriptions = updated;
    }
    synchronized Preference save(String browser,String id,boolean enabled,boolean preview,String endpoint,String key,String auth) throws IOException {
        if (endpoint != null && !endpoint.isEmpty()) subscribe(browser,endpoint,key,auth);
        Map<String,Preference> updated = new LinkedHashMap<>(preferences); Preference value = new Preference(true,enabled,preview); updated.put(browser+":"+id,value);
        if (updated.size() > 5000) throw new IllegalArgumentException("push_capacity_reached");
        persistPreferences(updated); preferences = updated; return value;
    }
    synchronized void enqueue(String recipient,String sender,long seq) throws IOException {
        Map<String,Event> updated = liveEvents();
        for (var e : preferences.entrySet()) {
            String[] pair = e.getKey().split(":"); Subscription subscription = subscriptions.get(pair[0]);
            if (!pair[1].equals(recipient) || !e.getValue().enabled()) continue;
            String id = UUID.randomUUID().toString().replace("-",""); updated.put(id,new Event(id,pair[0],subscription == null ? "0".repeat(64) : subscription.fingerprint(),recipient,sender,seq,now(),0,subscription == null ? 0 : now()));
        }
        while (updated.size() > 5000) updated.remove(updated.keySet().iterator().next());
        if (updated.equals(events)) return; persistEvents(updated); events = updated;
    }
    synchronized Event due() throws IOException {
        long current=System.currentTimeMillis();Event picked=null;
        for(Event event:events.values())if(event.next()>0&&event.next()<=current/1000&&!covered(event)&&delivery(event.browser()).pushed()+INTERVAL<=current)picked=event;
        if(picked!=null){Delivery old=delivery(picked.browser());putDelivery(picked.browser(),new Delivery(current,old.shown(),old.covered(),old.pending(),old.pendingAt()));}
        return picked;
    }
    synchronized Event get(String id) { Event event = events.get(id); return event != null && event.created() > now()-86400 ? event : null; }
    synchronized Subscription target(Event event) {
        Subscription sub = subscriptions.get(event.browser()); return sub != null && sub.fingerprint().equals(event.subscription()) && preference(event.browser(),event.recipient()).enabled() ? sub : null;
    }
    /** Check the device interval before reading previews; defer new events durably. */
    synchronized long defer(Event event,long wait) throws IOException {
        if(covered(event))return -1;
        long current=System.currentTimeMillis();Delivery old=delivery(event.browser());
        long allowed=Math.max(old.shown()+INTERVAL,current+Math.max(0,Math.min(INTERVAL,wait)));
        if(allowed>current) {
            String pending=event.id();boolean after=false;
            for(Event value:events.values()){if(value.id().equals(event.id()))after=true;if(after&&value.browser().equals(event.browser())&&preference(value.browser(),value.recipient()).enabled()&&!covered(value))pending=value.id();}
            putDelivery(event.browser(),new Delivery(old.pushed(),old.shown(),old.covered(),pending,allowed));
            Event queued=events.get(pending);
            if(queued!=null&&target(queued)!=null){Map<String,Event> next=liveEvents();next.put(pending,scheduled(queued,Math.max(allowed,old.pushed()+INTERVAL)));persistEvents(next);events=next;}
            return allowed-current;
        }
        return 0;
    }
    /** Called with chat/read locks held, after all current unread messages have been counted. */
    synchronized void claim(Event event) throws IOException {
        Delivery old=delivery(event.browser());String through=event.id();
        for(Event value:events.values())if(value.browser().equals(event.browser()))through=value.id();
        putDelivery(event.browser(),new Delivery(old.pushed(),System.currentTimeMillis(),through,"",0));
    }
    synchronized void discard(Event event,boolean releaseAttempt) throws IOException {
        Map<String,Event> next=liveEvents();if(next.remove(event.id())!=null){persistEvents(next);events=next;}
        Delivery old=delivery(event.browser());boolean pending=old.pending().equals(event.id());
        String replacement=old.pending();long pendingAt=old.pendingAt();
        if(pending){replacement="";for(Event value:events.values())if(value.browser().equals(event.browser())&&preference(value.browser(),value.recipient()).enabled()&&!covered(value))replacement=value.id();if(replacement.isEmpty())pendingAt=0;}
        putDelivery(event.browser(),new Delivery(releaseAttempt?0:old.pushed(),old.shown(),old.covered(),replacement,pendingAt));
    }
    private static Event scheduled(Event event,long millis){return new Event(event.id(),event.browser(),event.subscription(),event.recipient(),event.sender(),event.seq(),event.created(),event.attempts(),millis==0?0:(millis+999)/1000);}
    synchronized void complete(Event event,int code) throws IOException {
        deliveryStatus.put(event.browser(),code);
        if (code == 404 || code == 410) {
            Subscription sub = subscriptions.get(event.browser());
            if (sub != null && sub.fingerprint().equals(event.subscription())) { Map<String,Subscription> next = new LinkedHashMap<>(subscriptions); next.remove(event.browser()); persistSubscriptions(next); subscriptions = next; }
        }
        Map<String,Event> next = liveEvents(); Event current = next.get(event.id()); if (current == null || current.next() == 0) return;
        int attempts = Math.min(6,current.attempts()+1);
        boolean retry = (code == 0 || code == 429 || code >= 500) && attempts < 6 && event.created() > now()-3600;
        long delay = Math.min(600,15L << attempts);
        next.put(event.id(),new Event(event.id(),event.browser(),event.subscription(),event.recipient(),event.sender(),event.seq(),event.created(),attempts,retry ? now()+delay : 0));
        if(code>=200&&code<300)for(Event value:List.copyOf(next.values())) {
            if(value.browser().equals(event.browser()))next.put(value.id(),scheduled(value,0));
            if(value.id().equals(event.id()))break;
        }
        Delivery d=delivery(event.browser());Event pending=next.get(d.pending());
        if(pending!=null&&!covered(pending)&&d.pendingAt()>System.currentTimeMillis()&&target(pending)!=null)next.put(pending.id(),scheduled(pending,Math.max(d.pendingAt(),d.pushed()+INTERVAL)));
        persistEvents(next); events = next;
    }
    private Map<String,Event> liveEvents() { Map<String,Event> next = new LinkedHashMap<>(events); next.values().removeIf(e -> e.created() <= now()-86400); return next; }
    synchronized void prune(java.util.function.BiPredicate<String,String> authorized) throws IOException {
        Map<String,Preference> p = new LinkedHashMap<>(preferences);
        p.keySet().removeIf(key -> { String[] pair = key.split(":"); return !authorized.test(pair[0],pair[1]); });
        if (!p.equals(preferences)) { persistPreferences(p); preferences = p; }
        Set<String> browsers = new HashSet<>(); for (String key : p.keySet()) browsers.add(key.split(":")[0]);
        Map<String,Subscription> s = new LinkedHashMap<>(subscriptions); s.keySet().removeIf(key -> !browsers.contains(key));
        if (!s.equals(subscriptions)) { persistSubscriptions(s); subscriptions = s; }
        Map<String,Event> e = liveEvents(); e.values().removeIf(event -> !authorized.test(event.browser(),event.recipient()));
        if (!e.equals(events)) { persistEvents(e); events = e; }
        Map<String,Delivery> d=new LinkedHashMap<>(deliveries);d.entrySet().removeIf(entry->!browsers.contains(entry.getKey())&&Math.max(entry.getValue().pushed(),entry.getValue().shown())+INTERVAL<System.currentTimeMillis());
        if(!d.equals(deliveries)){persistDeliveries(d);deliveries=d;}
    }
    private void putDelivery(String browser,Delivery value) throws IOException {
        Map<String,Delivery> next=new LinkedHashMap<>(deliveries);next.put(browser,value);
        if(next.size()>5000)next.entrySet().removeIf(entry->!entry.getKey().equals(browser)&&enabledAccounts(entry.getKey()).isEmpty()&&Math.max(entry.getValue().pushed(),entry.getValue().shown())+INTERVAL<System.currentTimeMillis());
        if(next.size()>5000)throw new IOException("Push device capacity reached");
        persistDeliveries(next);deliveries=next;
    }
    private void persistDeliveries(Map<String,Delivery> values) throws IOException {
        StringBuilder data=new StringBuilder("# chawe-push-delivery-v1\n");
        for(var entry:values.entrySet()){Delivery d=entry.getValue();data.append(entry.getKey()).append('\t').append(d.pushed()).append('\t').append(d.shown()).append('\t').append(d.covered()).append('\t').append(d.pending()).append('\t').append(d.pendingAt()).append('\n');}
        write("push-delivery-v1.tsv",data);
    }
    private void persistPreferences(Map<String,Preference> values) throws IOException {
        StringBuilder data = new StringBuilder("# chawe-push-preferences-v1\n");
        for (var e : values.entrySet()) { String[] pair = e.getKey().split(":"); Preference p = e.getValue(); data.append(pair[0]).append('\t').append(pair[1]).append('\t').append(bit(p.confirmed())).append('\t').append(bit(p.enabled())).append('\t').append(bit(p.preview())).append('\n'); }
        write("push-preferences-v1.tsv",data);
    }
    private void persistSubscriptions(Map<String,Subscription> values) throws IOException {
        StringBuilder data = new StringBuilder("# chawe-push-subscriptions-v1\n");
        for (Subscription s : values.values()) data.append(s.browser()).append('\t').append(s.fingerprint()).append('\t').append(Base64.getEncoder().encodeToString(s.endpoint().getBytes(StandardCharsets.UTF_8))).append('\t').append(s.key()).append('\t').append(s.auth()).append('\n');
        write("push-subscriptions-v1.tsv",data);
    }
    private void persistEvents(Map<String,Event> values) throws IOException {
        StringBuilder data = new StringBuilder("# chawe-push-outbox-v1\n");
        for (Event e : values.values()) data.append(e.id()).append('\t').append(e.browser()).append('\t').append(e.subscription()).append('\t').append(e.recipient()).append('\t').append(e.sender()).append('\t').append(e.seq()).append('\t').append(e.created()).append('\t').append(e.attempts()).append('\t').append(e.next()).append('\n');
        write("push-outbox-v1.tsv",data);
    }
    private List<String[]> rows(String file,String header) throws IOException {
        Path path = directory.resolve(file); if (!Files.exists(path)) return List.of(); var lines = Files.readAllLines(path,StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals(header)) throw new IOException("Invalid push file version");
        return lines.subList(1,lines.size()).stream().map(line -> line.split("\t",-1)).toList();
    }
    private void write(String file,StringBuilder data) throws IOException { RenameTransaction.atomicWrite(directory.resolve(file),data.toString().getBytes(StandardCharsets.UTF_8)); }
    private static String fingerprint(String value) { try { return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); } }
    private static boolean hash(String value) { return value.matches("[a-f0-9]{64}"); }
    private static boolean flag(String value) { if (!value.equals("1") && !value.equals("0")) throw new IllegalArgumentException(); return value.equals("1"); }
    private static int bit(boolean value) { return value ? 1 : 0; }
    private static long now() { return Instant.now().getEpochSecond(); }
}
