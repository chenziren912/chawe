package chawe;

import java.util.*;

/** Short-lived activity signals: no draft text or persistent files. One lease per browser tab. */
final class TypingStatus {
    record Key(String conversation,String actor,String client) { }
    record Actor(String id,long remaining) { }
    private final Map<Key,Long> leases=new HashMap<>();
    private void prune(long now){leases.values().removeIf(expires->expires<=now);}
    synchronized void update(String conversation,String actor,String client,int remaining) {
        long now=System.nanoTime();prune(now);Key key=new Key(conversation,actor,client);
        if(remaining==0){leases.remove(key);return;}
        if(leases.size()>=10000&&!leases.containsKey(key))throw new IllegalArgumentException("typing_capacity_reached");
        leases.put(key,now+remaining*1_000_000L);
    }
    synchronized List<Actor> active(String conversation,String viewer) {
        long now=System.nanoTime();prune(now);Map<String,Long> actors=new TreeMap<>();
        for(var entry:leases.entrySet())if(entry.getKey().conversation().equals(conversation)&&!entry.getKey().actor().equals(viewer))
            actors.merge(entry.getKey().actor(),entry.getValue(),Math::max);
        return actors.entrySet().stream().map(entry->new Actor(entry.getKey(),Math.max(1,(entry.getValue()-now)/1_000_000))).toList();
    }
}
