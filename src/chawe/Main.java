package chawe;

import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import com.sun.net.httpserver.HttpServer;

public final class Main {
    public static void main(String[] args) throws Exception {
        Path dataDir = Path.of(requireEnv("CHAWE_DATA_DIR"));
        Path webDir = Path.of(requireEnv("CHAWE_WEB_DIR"));
        String origin = requireEnv("CHAWE_PUBLIC_ORIGIN");
        if (!origin.startsWith("https://") || origin.endsWith("/")) {
            throw new IllegalArgumentException("CHAWE_PUBLIC_ORIGIN must be an https origin without a trailing slash");
        }
        int port = Integer.parseInt(System.getenv().getOrDefault("CHAWE_PORT", "8080"));
        RenameTransaction.recover(dataDir);
        AccountStore accounts = new AccountStore(dataDir);
        ChatStore chats = new ChatStore(dataDir);
        RelationsStore relations = new RelationsStore(dataDir, accounts);
        Sessions sessions = new Sessions(dataDir);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 64);
        server.createContext("/", new HttpApp(accounts, chats, relations, sessions, webDir, origin));
        server.setExecutor(Executors.newFixedThreadPool(16));
        server.start();
        System.out.println("Chawe account server listening on 127.0.0.1:" + port);
    }

    private static String requireEnv(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }
}
