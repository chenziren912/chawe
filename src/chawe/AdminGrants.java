package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Administrator grants are provisioned on the server and bound to immutable account identities. */
final class AdminGrants {
    private final Set<String> ids;
    AdminGrants(Path directory) throws IOException {
        Path file=directory.resolve("super-admins-v1.tsv");Set<String> loaded=new HashSet<>();
        if(Files.exists(file)) {
            var lines=Files.readAllLines(file,StandardCharsets.UTF_8);
            if(lines.isEmpty()||!lines.get(0).equals("# chawe-super-admins-v1"))throw new IOException("Invalid administrator grants");
            for(String line:lines.subList(1,lines.size()))if(!AccountIdentities.validId(line)||!loaded.add(line))throw new IOException("Invalid administrator identity");
        }
        ids=Set.copyOf(loaded);
    }
    boolean contains(String id){return id!=null&&ids.contains(id);}
    Set<String> ids(){return ids;}
}
