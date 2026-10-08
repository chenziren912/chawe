package chawe;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.Comparator;

final class HttpApp implements HttpHandler {
    private static final int MAX_BODY = 65536;
    private AccountStore accounts;
    private ChatStore chats;
    private RelationsStore relations;
    private Sessions sessions;
    private BrowserAccounts browserAccounts;
    private RegistrationDevices registrationDevices;
    private UserProfiles userProfiles;
    private Avatars avatars;
    private AccountIdentities identities;
    private AdminGrants adminGrants;
    private ReadReceipts readReceipts;
    private PushNotifications notifications;
    private Attachments attachments;
    private VoiceStore voices;
    private GroupStore groups;
    private PinStore pins;
    private ReactionStore reactions;
    private final TypingStatus typing=new TypingStatus();
    private long lastPushMaintenance;
    private final java.util.concurrent.locks.ReentrantReadWriteLock lifecycle = new java.util.concurrent.locks.ReentrantReadWriteLock(true);
    private boolean unavailable;
    private final Path webDir;
    private final String origin;
    private final String recommendedGroupId;
    private final String csp;
    private final RateLimiter rates = new RateLimiter();

    HttpApp(AccountStore accounts, ChatStore chats, RelationsStore relations, Sessions sessions,
            Path webDir, String origin) throws IOException {
        this.accounts = accounts;
        this.chats = chats;
        this.relations = relations;
        this.sessions = sessions;
        this.browserAccounts = new BrowserAccounts(sessions.directory());
        this.registrationDevices = new RegistrationDevices(sessions.directory(), accounts);
        this.userProfiles = new UserProfiles(sessions.directory(), accounts);
        this.avatars = new Avatars(sessions.directory(), accounts);
        this.identities = new AccountIdentities(sessions.directory(),accounts);
        this.adminGrants = new AdminGrants(sessions.directory());
        this.readReceipts = new ReadReceipts(sessions.directory());
        this.attachments = new Attachments(sessions.directory());
        this.voices = new VoiceStore(sessions.directory());
        this.groups = new GroupStore(sessions.directory(),adminGrants.ids());
        this.recommendedGroupId = System.getenv().getOrDefault("CHAWE_RECOMMENDED_GROUP_ID", "").strip();
        if (!recommendedGroupId.isEmpty() && !AccountIdentities.validId(recommendedGroupId))
            throw new IllegalArgumentException("CHAWE_RECOMMENDED_GROUP_ID must be a group ID");
        this.pins = new PinStore(sessions.directory());
        this.reactions = new ReactionStore(sessions.directory());
        this.attachments.expire(identities,chats,groups);
        this.notifications = new PushNotifications(sessions.directory());
        this.notifications.prune(this::pushAuthorized);
        this.lastPushMaintenance = java.time.Instant.now().getEpochSecond();
        this.webDir = webDir;
        this.origin = origin;
        String html = Files.readString(webDir.resolve("index.html"), StandardCharsets.UTF_8);
        this.csp = "default-src 'none'; script-src 'self' "
            + scriptHash(between(html, "<script>", "</script>")) + " "
            + scriptHash(between(html, "<script type=\"module\" crossorigin>", "</script>"))
            + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            + "connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
        var pushWorker = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task,"chawe-web-push"); thread.setDaemon(true); return thread;
        });
        pushWorker.scheduleWithFixedDelay(this::dispatchPush,1,200,java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    @Override public void handle(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath(), method = exchange.getRequestMethod();
        java.util.concurrent.locks.Lock gate = method.equals("POST") && (path.equals("/api/me/username") || path.equals("/api/admin/accounts/delete")) ? lifecycle.writeLock() : lifecycle.readLock();
        if ((method.equals("GET") || method.equals("HEAD")) && (path.equals("/api/attachments/file") || path.equals("/api/attachments/download"))) { handleAttachmentFile(exchange); return; }
        if (method.equals("POST") && path.equals("/api/voice/play")) { handleOnceVoice(exchange); return; }
        gate.lock();
        try {
            commonHeaders(exchange);
            if (unavailable) { json(exchange,503,"{\"error\":\"account_update_pending\"}"); return; }
            if (path.startsWith("/api/") && !List.of("/api/me","/api/accounts","/api/login","/api/register","/api/avatar","/api/groups/avatar","/api/attachments/file","/api/notifications/message","/api/notifications/refresh").contains(path)) {
                String expected = exchange.getRequestHeaders().getFirst("X-Chawe-Identity");
                if (expected != null) {
                    Sessions.Access loggedIn = session(exchange);
                    if (loggedIn == null || !expected.equals(identities.id(loggedIn.username()))) { json(exchange,401,"{\"error\":\"unauthorized\"}"); return; }
                }
                String version = exchange.getRequestHeaders().getFirst("X-Chawe-Directory-Version");
                if (!Long.toString(identities.generation()).equals(version)) {
                    json(exchange,409,"{\"error\":" + quote(version == null ? "client_update_required" : "directory_changed") + "}"); return;
                }
            }
            if (method.equals("GET")) {
                if(path.equals("/api/pins")){pinApi(exchange,false);return;}
                if(path.equals("/api/reactions")){reactionApi(exchange,false);return;}
                if(path.startsWith("/api/groups/")){groupApi(exchange,path.substring(12),false);return;}
                switch (path) {
                    case "/", "/index.html" -> home(exchange);
                    case "/wechat-upside-down.svg" -> staticFile(exchange, "wechat-upside-down.svg", "image/svg+xml; charset=utf-8");
                    case "/app" -> app(exchange);
                    case "/chat.css" -> staticFile(exchange, "chat.css", "text/css; charset=utf-8");
                    case "/chat.js" -> staticFile(exchange, "chat.js", "text/javascript; charset=utf-8");
                    case "/typing.js" -> staticFile(exchange,"typing.js","text/javascript; charset=utf-8");
                    case "/scrollbars.js" -> staticFile(exchange,"scrollbars.js","text/javascript; charset=utf-8");
                    case "/scrollbars.css" -> staticFile(exchange,"scrollbars.css","text/css; charset=utf-8");
                    case "/attachments.js" -> staticFile(exchange,"attachments.js","text/javascript; charset=utf-8");
                    case "/media-cache.js" -> staticFile(exchange,"media-cache.js","text/javascript; charset=utf-8");
                    case "/media-cache-worker.js" -> staticFile(exchange,"media-cache-worker.js","text/javascript; charset=utf-8");
                    case "/attachments.css" -> staticFile(exchange,"attachments.css","text/css; charset=utf-8");
                    case "/voice.js" -> staticFile(exchange,"voice.js","text/javascript; charset=utf-8");
                    case "/voice.css" -> staticFile(exchange,"voice.css","text/css; charset=utf-8");
                    case "/groups.js" -> staticFile(exchange,"groups.js","text/javascript; charset=utf-8");
                    case "/groups.css" -> staticFile(exchange,"groups.css","text/css; charset=utf-8");
                    case "/pins.js" -> staticFile(exchange,"pins.js","text/javascript; charset=utf-8");
                    case "/pins.css" -> staticFile(exchange,"pins.css","text/css; charset=utf-8");
                    case "/reactions.js" -> staticFile(exchange,"reactions.js","text/javascript; charset=utf-8");
                    case "/reactions.css" -> staticFile(exchange,"reactions.css","text/css; charset=utf-8");
                    case "/article-editor.js" -> staticFile(exchange,"article-editor.js","text/javascript; charset=utf-8");
                    case "/article.js" -> staticFile(exchange,"article.js","text/javascript; charset=utf-8");
                    case "/article-editor.css" -> staticFile(exchange,"article-editor.css","text/css; charset=utf-8");
                    case "/article-notices.txt" -> staticFile(exchange,"article-notices.txt","text/plain; charset=utf-8");
                    case "/article-editor.js.LEGAL.txt" -> staticFile(exchange,"article-editor.js.LEGAL.txt","text/plain; charset=utf-8");
                    case "/article-editor.css.LEGAL.txt" -> staticFile(exchange,"article-editor.css.LEGAL.txt","text/plain; charset=utf-8");
                    case "/notifications.js" -> staticFile(exchange,"notifications.js","text/javascript; charset=utf-8");
                    case "/notification-worker.js" -> staticFile(exchange,"notification-worker.js","text/javascript; charset=utf-8");
                    case "/account-auth.js" -> staticFile(exchange, "account-auth.js", "text/javascript; charset=utf-8");
                    case "/account-auth.css" -> staticFile(exchange, "account-auth.css", "text/css; charset=utf-8");
                    case "/chat-wallpaper.svg" -> staticFile(exchange, "chat-wallpaper.svg", "image/svg+xml; charset=utf-8");
                    case "/api/me" -> me(exchange);
                    case "/api/typing" -> typingApi(exchange,false);
                    case "/api/accounts" -> accountList(exchange);
                    case "/api/notifications" -> notificationSettings(exchange);
                    case "/api/notifications/events" -> notificationEvents(exchange);
                    case "/api/voice/status" -> voiceStatus(exchange);
                    case "/api/voice/state" -> voiceState(exchange);
                    case "/api/notifications/message" -> notificationMessage(exchange);
                    case "/api/contacts" -> contacts(exchange);
                    case "/api/people" -> people(exchange);
                    case "/api/requests" -> retiredRequests(exchange);
                    case "/api/profile" -> profile(exchange);
                    case "/api/me/profile" -> selfProfile(exchange);
                    case "/api/avatar" -> avatarImage(exchange);
                    case "/api/blocks" -> blocks(exchange);
                    case "/api/chats" -> chatList(exchange);
                    case "/api/messages" -> messages(exchange);
                    case "/api/messages/changes" -> messageChanges(exchange);
                    case "/api/attachments" -> uploadStatus(exchange);
                    default -> json(exchange, 404, "{\"error\":\"not_found\"}");
                }
            } else if (method.equals("POST")) {
                if (!origin.equals(exchange.getRequestHeaders().getFirst("Origin"))) {
                    json(exchange, 403, "{\"error\":\"origin_rejected\"}");
                    return;
                }
                if(path.equals("/api/pins")){pinApi(exchange,true);return;}
                if(path.equals("/api/reactions")){reactionApi(exchange,true);return;}
                if(path.startsWith("/api/groups/")){groupApi(exchange,path.substring(12),true);return;}
                switch (path) {
                    case "/api/register" -> register(exchange);
                    case "/api/typing" -> typingApi(exchange,true);
                    case "/api/login" -> login(exchange);
                    case "/api/logout" -> logout(exchange);
                    case "/api/accounts/switch" -> switchAccount(exchange);
                    case "/api/me/profile/save" -> saveSelfProfile(exchange);
                    case "/api/me/avatar" -> saveAvatar(exchange);
                    case "/api/me/avatar/reset" -> resetAvatar(exchange);
                    case "/api/me/username" -> renameUsername(exchange);
                    case "/api/admin/accounts/delete" -> deleteAccount(exchange);
                    case "/api/notifications/save" -> saveNotifications(exchange);
                    case "/api/notifications/refresh" -> refreshNotificationSubscription(exchange);
                    case "/api/messages/send" -> sendMessage(exchange);
                    case "/api/articles/send" -> sendArticle(exchange);
                    case "/api/messages/read" -> markMessagesRead(exchange);
                    case "/api/attachments/create" -> uploadAction(exchange,"create");
                    case "/api/attachments/chunk" -> uploadAction(exchange,"chunk");
                    case "/api/attachments/send" -> uploadAction(exchange,"send");
                    case "/api/attachments/cancel" -> uploadAction(exchange,"cancel");
                    case "/api/voice/create" -> voiceAction(exchange,"create");
                    case "/api/voice/chunk" -> voiceAction(exchange,"chunk");
                    case "/api/voice/send" -> voiceAction(exchange,"send");
                    case "/api/voice/cancel" -> voiceAction(exchange,"cancel");
                    case "/api/messages/edit" -> messageAction(exchange, "edit");
                    case "/api/messages/retract" -> messageAction(exchange, "retract");
                    case "/api/messages/favorite" -> messageAction(exchange, "favorite");
                    case "/api/requests/send", "/api/requests/accept", "/api/requests/decline", "/api/requests/cancel" -> retiredRequests(exchange);
                    case "/api/contacts/save" -> saveContact(exchange);
                    case "/api/contacts/remove" -> removeContact(exchange);
                    case "/api/blocks/add" -> setBlock(exchange, true);
                    case "/api/blocks/remove" -> setBlock(exchange, false);
                    default -> json(exchange, 404, "{\"error\":\"not_found\"}");
                }
            } else {
                exchange.getResponseHeaders().set("Allow", "GET, POST");
                json(exchange, 405, "{\"error\":\"method_not_allowed\"}");
            }
        } catch (BadRequest | IllegalArgumentException e) {
            json(exchange, 400, "{\"error\":\"bad_request\"}");
        } catch (Exception e) {
            System.err.println("Request failed: " + e.getClass().getSimpleName());
            json(exchange, 500, "{\"error\":\"server_error\"}");
        } finally {
            try { exchange.close(); } finally { gate.unlock(); }
        }
    }

    private void register(HttpExchange exchange) throws IOException, BadRequest {
        String ip = clientIp(exchange);
        if (!rates.allow("register:" + ip, 20, 600)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}");
            return;
        }
        Map<String, String> form = form(exchange);
        String username = form.get("username"), password = form.get("password");
        if (!AccountStore.validUsername(username) || AccountStore.reservedUsername(username) || !Passwords.valid(password)) {
            json(exchange, 400, "{\"error\":\"invalid_credentials\"}");
            return;
        }
        String fingerprint = form.get("fingerprint");
        if (!RegistrationDevices.validFingerprint(fingerprint)) {
            json(exchange, 400, "{\"error\":\"device_fingerprint_required\"}"); return;
        }
        synchronized (browserAccounts) {
            Sessions.Access previous = session(exchange);
            if (!browserAccounts.canRemember(browserToken(exchange), previous == null ? null : previous.username(), username)) {
                json(exchange, 409, "{\"error\":\"browser_account_limit\"}"); return;
            }
            switch (registrationDevices.register(username, password, fingerprint)) {
                case CREATED -> {
                    if (signIn(exchange, username)) json(exchange, 201, "{\"ok\":true}");
                    else json(exchange, 409, "{\"error\":\"browser_account_limit\"}");
                }
                case EXISTS -> json(exchange, 409, "{\"error\":\"username_taken\"}");
                case FULL -> json(exchange, 503, "{\"error\":\"capacity_reached\"}");
                case INVALID -> json(exchange, 400, "{\"error\":\"invalid_credentials\"}");
                case DEVICE_LIMIT -> json(exchange, 409, "{\"error\":\"device_registration_limit\"}");
                case INVALID_DEVICE -> json(exchange, 400, "{\"error\":\"device_fingerprint_required\"}");
            }
        }
    }

    private void login(HttpExchange exchange) throws IOException, BadRequest {
        String ip = clientIp(exchange);
        if (!rates.allow("login-ip:" + ip, 40, 600)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}");
            return;
        }
        Map<String, String> form = form(exchange);
        String username = form.get("username"), password = form.get("password");
        if (!AccountStore.validUsername(username) || password == null || password.length() > 128) {
            json(exchange, 401, "{\"error\":\"login_failed\"}");
            return;
        }
        if (!rates.allow("login-user:" + username.toLowerCase(), 10, 600)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}");
            return;
        }
        if (!accounts.authenticate(username, password)) {
            json(exchange, 401, "{\"error\":\"login_failed\"}");
            return;
        }
        if (signIn(exchange, username)) json(exchange, 200, "{\"ok\":true}");
        else json(exchange, 409, "{\"error\":\"browser_account_limit\"}");
    }

    private void logout(HttpExchange exchange) throws IOException {
        synchronized (browserAccounts) {
            String user = requireUser(exchange); if (user == null) return;
            sessions.remove(token(exchange));
            BrowserAccounts.Access remaining = browserAccounts.forget(browserToken(exchange), user);
            clearCookie(exchange, "__Host-chawe_session");
            if (remaining == null) clearCookie(exchange, "__Host-chawe_accounts");
            else setBrowserCookie(exchange, browserToken(exchange));
            json(exchange, 200, "{\"ok\":true,\"username\":" + (remaining == null ? "null" : quote(remaining.selected())) + "}");
        }
    }

    private boolean signIn(HttpExchange exchange, String username) throws IOException {
        identities.ensure(username);
        synchronized (browserAccounts) {
            Sessions.Access previous = session(exchange);
            if (!browserAccounts.canRemember(browserToken(exchange), previous == null ? null : previous.username(), username)) return false;
            String browser = browserAccounts.remember(browserToken(exchange), previous == null ? null : previous.username(), username);
            setCookie(exchange, sessions.replace(token(exchange), username));
            setBrowserCookie(exchange, browser);
            return true;
        }
    }

    private void accountList(HttpExchange exchange) throws IOException {
        String user = requireUser(exchange);
        if (user == null) return;
        synchronized (browserAccounts) {
            String value = browserToken(exchange);
            BrowserAccounts.Access access = browserAccounts.access(value);
            if (access == null) {
                value = browserAccounts.remember(value, null, user);
                setBrowserCookie(exchange, value);
                access = browserAccounts.access(value);
            }
            StringBuilder result = new StringBuilder("{\"current\":").append(quote(user)).append(",\"accounts\":[");
            for (String name : access.users()) {
                if (!accounts.exists(name)) continue;
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append("{\"username\":").append(quote(name)).append(",\"nickname\":").append(quote(userProfiles.nickname(name)))
                    .append(",\"id\":").append(quote(identities.id(name)))
                    .append(avatarFields(name))
                    .append(",\"active\":").append(user.equals(name)).append('}');
            }
            json(exchange, 200, result.append("],\"maxAccounts\":").append(BrowserAccounts.MAX_ACCOUNTS).append('}').toString());
        }
    }

    private void switchAccount(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("account-switch:" + clientIp(exchange), 120, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}"); return;
        }
        String target = form(exchange).get("username");
        synchronized (browserAccounts) {
            if (!AccountStore.validUsername(target) || !accounts.exists(target)
                    || !browserAccounts.select(browserToken(exchange), target)) {
                json(exchange, 403, "{\"error\":\"account_not_saved\"}"); return;
            }
            setBrowserCookie(exchange, browserToken(exchange));
            json(exchange, 200, "{\"ok\":true,\"username\":" + quote(target) + "}");
        }
    }

    private void me(HttpExchange exchange) throws IOException {
        String expectedId = exchange.getRequestHeaders().getFirst("X-Chawe-Identity");
        Sessions.Access access = expectedId == null ? session(exchange) : session(exchange,identities.username(expectedId));
        if (access != null && expectedId != null && !expectedId.equals(identities.id(access.username()))) access = null;
        if (access == null) {
            json(exchange, 401, "{\"error\":\"unauthorized\"}");
        } else {
            json(exchange, 200, "{\"username\":" + quote(access.username()) + ",\"id\":" + quote(identities.id(access.username()))
                + ",\"superAdmin\":" + adminGrants.contains(identities.id(access.username()))
                + ",\"directoryVersion\":" + identities.generation() + ",\"nickname\":" + quote(userProfiles.nickname(access.username())) + avatarFields(access.username()) + "}");
        }
    }

    private void selfProfile(HttpExchange exchange) throws IOException {
        String user = requireUser(exchange); if (user == null) return;
        json(exchange,200,selfProfileJson(userProfiles.get(user)));
    }

    private void saveSelfProfile(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("profile-save:" + user,60,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> values = form(exchange); long revision;
        try { revision = Long.parseLong(values.getOrDefault("revision","-1")); } catch (NumberFormatException error) { throw new BadRequest(); }
        if (revision < 0) throw new BadRequest();
        try {
            UserProfiles.Profile profile = userProfiles.save(user,values.getOrDefault("nickname",""),values.getOrDefault("birthday",""),
                values.getOrDefault("phone",""),values.getOrDefault("email",""),values.getOrDefault("visibility","contacts"),values.getOrDefault("excluded",""),revision);
            json(exchange,200,selfProfileJson(profile));
        } catch (UserProfiles.InvalidProfile error) {
            json(exchange,error.getMessage().equals("profile_changed") ? 409 : 400,"{\"error\":" + quote(error.getMessage()) + "}");
        }
    }

    private String selfProfileJson(UserProfiles.Profile profile) {
        StringBuilder result = new StringBuilder("{\"username\":").append(quote(profile.username()))
            .append(",\"id\":").append(quote(identities.id(profile.username())))
            .append(",\"superAdmin\":").append(adminGrants.contains(identities.id(profile.username())))
            .append(",\"usernameChangeAllowedAt\":").append(identities.allowedAt(profile.username()) * 1000)
            .append(",\"nickname\":").append(quote(profile.nickname())).append(",\"birthday\":").append(quote(profile.birthday()))
            .append(",\"age\":").append(profile.birthday().isEmpty() ? "null" : UserProfiles.age(profile))
            .append(",\"phone\":").append(quote(profile.phone())).append(",\"email\":").append(quote(profile.email()))
            .append(",\"visibility\":").append(quote(profile.visibility())).append(",\"revision\":").append(profile.revision())
            .append(avatarFields(profile.username()))
            .append(",\"neverShowTo\":[");
        for (String peer : profile.neverShowTo()) { if (result.charAt(result.length()-1) != '[') result.append(','); result.append(quote(peer)); }
        return result.append("]}").toString();
    }

    private String avatarFields(String user) {
        Avatars.Avatar avatar = avatars.get(user);
        String url = avatar.hash().isEmpty() ? "" : "/api/avatar?peer=" + user + "&v=" + avatar.hash();
        return ",\"avatarVersion\":" + avatar.revision() + ",\"avatarUrl\":" + quote(url);
    }
    private void renameUsername(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("rename:" + identities.id(user),5,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        String name = form(exchange).getOrDefault("username","").strip();
        if (!AccountStore.validUsername(name) || AccountStore.reservedUsername(name)) { json(exchange,400,"{\"error\":\"invalid_username\"}"); return; }
        if (name.equals(user)) { json(exchange,400,"{\"error\":\"username_unchanged\"}"); return; }
        long now = java.time.Instant.now().getEpochSecond();
        if (now < identities.allowedAt(user)) { json(exchange,429,"{\"error\":\"username_cooldown\"}"); return; }
        if (accounts.exists(name)) { json(exchange,409,"{\"error\":\"username_taken\"}"); return; }
        Path directory = sessions.directory();
        String originalId = identities.id(user);
        try {
            RenameTransaction.rename(directory,user,name,identities.renamed(user,name,now));
            reloadStores(directory);
        } catch (IOException | RuntimeException error) {
            unavailable = true;
            try { RenameTransaction.recover(directory); reloadStores(directory); unavailable = false; }
            catch (Exception recoveryError) { error.addSuppressed(recoveryError); }
            if (unavailable || !originalId.equals(identities.id(name))) throw error;
        }
        String browser = browserToken(exchange);
        if (browserAccounts.access(browser) == null) clearCookie(exchange,"__Host-chawe_accounts"); else setBrowserCookie(exchange,browser);
        clearCookie(exchange,"__Host-chawe_session");
        json(exchange,200,"{\"ok\":true,\"username\":" + quote(name) + ",\"signedOutEverywhere\":true}");
    }
    private void reloadStores(Path directory) throws IOException {
        AccountStore a = new AccountStore(directory); ChatStore c = new ChatStore(directory);
        RelationsStore r = new RelationsStore(directory,a); Sessions s = new Sessions(directory);
        BrowserAccounts b = new BrowserAccounts(directory); RegistrationDevices d = new RegistrationDevices(directory,a);
        UserProfiles p = new UserProfiles(directory,a); Avatars v = new Avatars(directory,a); AccountIdentities i = new AccountIdentities(directory,a);
        AdminGrants grants = new AdminGrants(directory); GroupStore g = new GroupStore(directory,grants.ids());
        ReadReceipts receipts = new ReadReceipts(directory); Attachments uploads = new Attachments(directory); VoiceStore recordings = new VoiceStore(directory);
        PinStore pinned = new PinStore(directory); ReactionStore responses = new ReactionStore(directory); PushNotifications push = new PushNotifications(directory);
        accounts = a; chats = c; relations = r; sessions = s; browserAccounts = b; registrationDevices = d; userProfiles = p; avatars = v; identities = i;
        adminGrants = grants; groups = g; readReceipts = receipts; attachments = uploads; voices = recordings; pins = pinned; reactions = responses; notifications = push;
        notifications.prune(this::pushAuthorized);
    }
    private void deleteAccount(HttpExchange exchange) throws IOException, BadRequest {
        String actor = requireUser(exchange); if(actor == null) return;
        if(!adminGrants.contains(identities.id(actor))) { json(exchange,403,"{\"error\":\"super_admin_required\"}"); return; }
        if(!rates.allow("account-delete:"+identities.id(actor),5,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> values = form(exchange); String id = values.get("id"), expected = values.get("username");
        if(!AccountIdentities.validId(id) || !AccountStore.validUsername(expected)) throw new BadRequest();
        String target = identities.username(id);
        if(target == null) { json(exchange,404,"{\"error\":\"user_not_found\"}"); return; }
        if(!target.equals(expected)) { json(exchange,409,"{\"error\":\"account_changed\"}"); return; }
        Path directory = sessions.directory();
        try {
            RenameTransaction.deleteAccount(directory,target,id,identities.deleted(target),groups.accountDeleted(id));
            reloadStores(directory);
        } catch(IOException | RuntimeException error) {
            unavailable = true;
            try { RenameTransaction.recover(directory); reloadStores(directory); unavailable = false; }
            catch(Exception recoveryError) { error.addSuppressed(recoveryError); }
            if(unavailable || identities.username(id) != null) throw error;
        }
        if(actor.equals(target)) clearCookie(exchange,"__Host-chawe_session");
        String browser = browserToken(exchange);
        if(browserAccounts.access(browser) == null) clearCookie(exchange,"__Host-chawe_accounts");
        json(exchange,200,"{\"ok\":true,\"deletedId\":"+quote(id)+",\"username\":"+quote(target)+"}");
    }
    private void avatarImage(HttpExchange exchange) throws IOException, BadRequest {
        Map<String,String> query = params(exchange);
        // Images cannot attach X-Chawe-Account; an explicit account is still checked against the login cookie.
        Sessions.Access access = session(exchange,query.get("account"));
        if (access == null) { json(exchange,401,"{\"error\":\"unauthorized\"}"); return; }
        String peer = checkedPeer(exchange,access.username(),query.get("peer"),true); if (peer == null) return;
        byte[] bytes = avatars.read(peer,query.get("v"));
        if (bytes == null) { json(exchange,404,"{\"error\":\"avatar_not_set\"}"); return; }
        exchange.getResponseHeaders().set("Content-Type","image/png");
        if (query.get("v") != null) exchange.getResponseHeaders().set("Cache-Control","private, max-age=300, immutable");
        exchange.sendResponseHeaders(200,bytes.length); exchange.getResponseBody().write(bytes);
    }
    private void saveAvatar(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("avatar:" + user,20,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        if (!"image/png".equalsIgnoreCase(exchange.getRequestHeaders().getFirst("Content-Type"))) throw new BadRequest();
        long revision = avatarRevision(exchange.getRequestHeaders().getFirst("X-Chawe-Avatar-Version"));
        byte[] bytes = exchange.getRequestBody().readNBytes(Avatars.MAX_UPLOAD + 1);
        if (bytes.length > Avatars.MAX_UPLOAD) { json(exchange,413,"{\"error\":\"avatar_too_large\"}"); return; }
        try { avatars.save(user,bytes,revision); json(exchange,200,"{\"username\":" + quote(user) + avatarFields(user) + "}"); }
        catch (IllegalArgumentException error) { avatarError(exchange,error); }
    }
    private void resetAvatar(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("avatar:" + user,20,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        long revision = avatarRevision(form(exchange).get("revision"));
        try { avatars.reset(user,revision); json(exchange,200,"{\"username\":" + quote(user) + avatarFields(user) + "}"); }
        catch (IllegalArgumentException error) { avatarError(exchange,error); }
    }
    private static long avatarRevision(String value) throws BadRequest {
        try { long revision = Long.parseLong(value); if (revision < 0) throw new NumberFormatException(); return revision; }
        catch (NumberFormatException error) { throw new BadRequest(); }
    }
    private void avatarError(HttpExchange exchange,IllegalArgumentException error) throws IOException {
        String code = "avatar_changed".equals(error.getMessage()) ? "avatar_changed" : "invalid_avatar";
        json(exchange,code.equals("avatar_changed") ? 409 : 400,"{\"error\":" + quote(code) + "}");
    }

    private void contacts(HttpExchange exchange) throws IOException {
        String user = requireUser(exchange);
        if (user == null) return;
        synchronized (relations) {
            List<String> names = relations.contacts(user);
            StringBuilder result = new StringBuilder("{\"contacts\":[");
            for (String name : names) {
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append(quote(name));
            }
            result.append("],\"details\":[");
            for (String name : names) {
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append(personJson(user, name));
            }
            json(exchange, 200, result.append("]}").toString());
        }
    }

    private void people(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        String query = params(exchange).getOrDefault("query", "").trim();
        if (query.startsWith("@")) query = query.substring(1);
        if (query.codePointCount(0,query.length()) > 40) throw new BadRequest();
        java.util.LinkedHashSet<String> found = new java.util.LinkedHashSet<>(accounts.search(query, user));
        String needle = query.toLowerCase(java.util.Locale.ROOT);
        for (String peer : accounts.search("",user)) {
            if (userProfiles.nickname(peer).toLowerCase(java.util.Locale.ROOT).contains(needle)) found.add(peer);
        }
        StringBuilder result = new StringBuilder("{\"people\":[");
        synchronized (relations) {
            for (String name : found) {
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append(personJson(user, name));
            }
        }
        json(exchange, 200, result.append("]}").toString());
    }

    private String recommendedGroupsJson(String user) {
        if (recommendedGroupId.isEmpty()) return "[]";
        try {
            GroupStore.Group group = groups.get(recommendedGroupId);
            // Recommendations never expose a private/deleted group or its member list.
            if (!group.type.equals("public")) return "[]";
            String uid = identities.id(user);
            String avatarUrl = group.avatar.isEmpty() ? "" : "/api/groups/avatar?id=" + group.id + "&accountId=" + uid + "&v=" + group.avatar;
            return "[{\"id\":" + quote(group.id) + ",\"name\":" + quote(group.name)
                + ",\"avatarUrl\":" + quote(avatarUrl) + ",\"memberCount\":" + group.members.size()
                + ",\"joined\":" + group.members.containsKey(uid) + "}]";
        } catch (IllegalArgumentException missing) { return "[]"; }
    }

    private void profile(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        Map<String,String> query = params(exchange);
        String groupId=GroupStore.isPeer(query.get("peer"))?query.get("peer").substring(6):groups.exists(query.get("peerId"))?query.get("peerId"):null;
        if(groupId!=null){try{var g=groups.get(groupId);if(!g.members.containsKey(identities.id(user))&&!g.type.equals("public"))throw new IllegalArgumentException("group_not_member");json(exchange,200,groupJson(g,user));}
            catch(IllegalArgumentException error){json(exchange,403,"{\"error\":"+quote(error.getMessage())+"}");}return;}
        String candidate = query.containsKey("peerId") ? identities.username(query.get("peerId")) : query.get("peer");
        String peer = checkedPeer(exchange, user, candidate, true);
        if (peer != null) {
            synchronized (relations) {
                UserProfiles.Profile info = userProfiles.get(peer);
                boolean own = user.equals(peer);
                boolean reveal = own || (!info.neverShowTo().contains(user) && relations.canMessage(user,peer)
                    && (info.visibility().equals("everyone") || relations.person(peer,user).contact()));
                String basic = personJson(user,peer);
                json(exchange,200,basic.substring(0,basic.length()-1) + ",\"contactsVisible\":" + reveal
                    + (reveal ? ",\"phone\":" + quote(info.phone()) + ",\"email\":" + quote(info.email()) : "") + "}");
            }
        }
    }

    private void blocks(HttpExchange exchange) throws IOException {
        String user = requireUser(exchange);
        if (user == null) return;
        StringBuilder result = new StringBuilder("{\"people\":[");
        synchronized (relations) {
            for (String peer : relations.blockedUsers(user)) {
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append(personJson(user, peer));
            }
        }
        json(exchange, 200, result.append("]}").toString());
    }

    private void retiredRequests(HttpExchange exchange) throws IOException {
        if (requireUser(exchange) != null) json(exchange, 410, "{\"error\":\"client_update_required\"}");
    }

    private String personJson(String user, String peer) {
        RelationsStore.Person person = relations.person(user, peer);
        String nickname = userProfiles.nickname(peer);
        String displayName = user.equals(peer) ? "收藏夹" : !person.alias().isEmpty() ? person.alias() : nickname.isEmpty() ? peer : nickname;
        return "{\"username\":" + quote(peer) + ",\"alias\":" + quote(person.alias())
            + ",\"id\":" + quote(identities.id(peer))
            + ",\"superAdmin\":" + adminGrants.contains(identities.id(peer)) + ",\"canDeleteAccount\":" + adminGrants.contains(identities.id(user))
            + ",\"nickname\":" + quote(nickname) + avatarFields(peer) + ",\"displayName\":" + quote(displayName) + ",\"contact\":" + person.contact()
            + ",\"blockedByMe\":" + person.blockedByMe() + ",\"canMessage\":" + person.canMessage()
            + ",\"status\":" + quote(person.contact() ? "friend" : "none") + "}";
    }

    private void chatList(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        String query = params(exchange).getOrDefault("query", "").trim();
        if (query.length() > 100) throw new BadRequest();
        Map<String, ChatStore.Chat> matches = new HashMap<>();
        for (ChatStore.Chat chat : chats.chats(user, query)) matches.put(chat.peer(), chat);
        if (!query.isEmpty()) {
            String needle = (query.startsWith("@") ? query.substring(1) : query).toLowerCase(java.util.Locale.ROOT);
            for (ChatStore.Chat chat : chats.chats(user, "")) {
                if (relations.displayName(user, chat.peer()).toLowerCase(java.util.Locale.ROOT).contains(needle)
                        || userProfiles.nickname(chat.peer()).toLowerCase(java.util.Locale.ROOT).contains(needle))
                    matches.put(chat.peer(), chat);
            }
        }
        List<ChatStore.Chat> found = new ArrayList<>(matches.values());
        for(var group:groups.list(identities.id(user),"",false)){
            String peer=GroupStore.peer(group.id);var last=chats.lastMessage(user,peer);String titleNeedle=query.replaceFirst("^@","").toLowerCase(java.util.Locale.ROOT);
            if(!query.isEmpty()&&!group.name.toLowerCase(java.util.Locale.ROOT).contains(titleNeedle)&&!group.handle.contains(titleNeedle)){
                var page=chats.messages(user,peer,0,1,query,null,group.members.get(identities.id(user)).floor());if(page.messages().isEmpty())continue;last=page.messages().get(0);
            }
            found.add(new ChatStore.Chat(peer,last==null?"群聊已创建":ChatStore.preview(last),last==null?group.created:last.time()));
        }
        found.sort(Comparator.comparingLong(ChatStore.Chat::lastAt).reversed().thenComparing(ChatStore.Chat::peer));
        StringBuilder result = new StringBuilder("{\"chats\":[");
        synchronized (relations) {
            for (ChatStore.Chat chat : found) {
                if (result.charAt(result.length() - 1) != '[') result.append(',');
                result.append("{\"peer\":").append(quote(chat.peer()))
                    .append(",\"lastText\":").append(quote(chat.lastText()))
                    .append(",\"lastAt\":").append(chat.lastAt())
                    .append(",\"contact\":").append(!GroupStore.isPeer(chat.peer())&&relations.person(user, chat.peer()).contact())
                    .append(",\"profile\":").append(GroupStore.isPeer(chat.peer())?groupJson(groups.get(chat.peer().substring(6)),user):personJson(user, chat.peer())).append('}');
            }
        }
        json(exchange, 200, result.append("],\"recommendedGroups\":")
            .append(query.isEmpty() ? recommendedGroupsJson(user) : "[]").append('}').toString());
    }

    private void messages(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        Map<String, String> params = params(exchange);
        String peer = params.get("with");
        if (!AccountStore.validUsername(peer) || !accounts.exists(peer)) {
            json(exchange, 404, "{\"error\":\"user_not_found\"}");
            return;
        }
        String query = params.getOrDefault("q", "").trim();
        if (query.length() > 100) throw new BadRequest();
        long before;
        long after;
        int limit;
        try {
            before = Long.parseLong(params.getOrDefault("before", "0"));
            after = Long.parseLong(params.getOrDefault("after", "0"));
            limit = Integer.parseInt(params.getOrDefault("limit", "50"));
        } catch (NumberFormatException e) { throw new BadRequest(); }
        if (before < 0 || after < 0 || (before > 0 && after > 0) || limit < 1 || limit > 100) throw new BadRequest();
        ChatStore.Page page = after > 0 && query.isEmpty()
            ? chats.messagesAfter(user, peer, after, limit)
            : chats.messages(user, peer, before, limit, query);
        StringBuilder result = new StringBuilder("{\"messages\":[");
        for (ChatStore.Message message : page.messages()) {
            if (result.charAt(result.length() - 1) != '[') result.append(',');
            result.append(privateMessageJson(message,user,peer));
        }
        json(exchange, 200, result.append("],\"more\":").append(page.more())
            .append(",\"revision\":").append(page.revision()).append(readReceiptJson(user,peer)).append('}').toString());
    }

    private void messageChanges(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        Map<String, String> data = params(exchange);
        String peer = checkedPeer(exchange, user, data.get("with"), true);
        if (peer == null) return;
        long after; int limit;
        try {
            after = Long.parseLong(data.getOrDefault("after", "0"));
            limit = Integer.parseInt(data.getOrDefault("limit", "100"));
        } catch (NumberFormatException error) { throw new BadRequest(); }
        if (after < 0 || limit < 1 || limit > 100) throw new BadRequest();
        ChatStore.Changes changes = chats.changes(user, peer, after, limit);
        StringBuilder result = new StringBuilder("{\"updates\":[");
        for (ChatStore.Message message : changes.updates()) {
            if (result.charAt(result.length() - 1) != '[') result.append(',');
            result.append(privateMessageJson(message,user,peer));
        }
        json(exchange, 200, result.append("],\"revision\":").append(changes.revision())
            .append(",\"more\":").append(changes.more()).append(readReceiptJson(user,peer)).append('}').toString());
    }

    private String readReceiptJson(String user,String peer) {
        String readerId = identities.id(user), peerId = identities.id(peer);
        return ",\"readThrough\":" + readReceipts.through(readerId,peerId)
            + ",\"peerReadThrough\":" + readReceipts.through(peerId,readerId);
    }

    private void typingApi(HttpExchange exchange,boolean write) throws IOException,BadRequest {
        String user=requireUser(exchange);if(user==null)return;
        String uid=identities.id(user);Map<String,String> values=write?form(exchange):params(exchange);
        if(!rates.allow((write?"typing-write:":"typing-read:")+uid,write?180:600,60)){json(exchange,429,"{\"error\":\"rate_limited\"}");return;}
        String peer=values.get("peer"),topic=values.getOrDefault("topic","general");
        synchronized(relations){synchronized(groups){
            boolean group=GroupStore.isPeer(peer);GroupStore.Group g=null;String key;
            if(group){g=groups.member(peer.substring(6),uid);if(!g.topics.containsKey(topic)||!g.topicsEnabled&&!topic.equals("general"))throw new BadRequest();key="group:"+g.id+":"+(g.topicsEnabled?topic:"general");}
            else {if(!AccountStore.validUsername(peer)||!accounts.exists(peer)||peer.equals(user))throw new BadRequest();if(!relations.canMessage(user,peer)){json(exchange,403,"{\"error\":\"message_unavailable\"}");return;}key=PinStore.key(uid,identities.id(peer),false);}
            if(write){
                String client=values.get("client");int remaining;
                try{remaining=Integer.parseInt(values.getOrDefault("remaining","3000"));}catch(NumberFormatException error){throw new BadRequest();}
                if(!AccountIdentities.validId(client)||remaining<0||remaining>3000)throw new BadRequest();
                if(remaining>0&&group)groups.checkSend(g.id,uid,"text",topic);
                typing.update(key,uid,client,remaining);json(exchange,200,"{\"ok\":true}");return;
            }
            List<String> rows=new ArrayList<>();
            for(var actor:typing.active(key,uid)) {
                String name=identities.username(actor.id());if(name==null||!accounts.exists(name))continue;
                if(group){if(!g.members.containsKey(actor.id())||!GroupStore.permits(g,actor.id(),"text")||g.topics.get(topic).closed()&&!GroupStore.manages(g,actor.id(),"manageTopics"))continue;}
                else if(!actor.id().equals(identities.id(peer)))continue;
                String label=relations.person(user,name).alias();if(label.isEmpty())label=userProfiles.nickname(name);if(label.isEmpty())label=name;
                rows.add("{\"id\":"+quote(actor.id())+",\"name\":"+quote(label)+",\"remaining\":"+actor.remaining()+"}");
            }
            json(exchange,200,"{\"actors\":["+String.join(",",rows)+"]}");
        }}
    }

    private void markMessagesRead(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("message-read:" + user,120,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> data = form(exchange);
        String peer = checkedPeer(exchange,user,data.get("peer"),true); if (peer == null) return;
        long seq;
        try { seq = Long.parseLong(data.getOrDefault("seq","0")); }
        catch (NumberFormatException error) { throw new BadRequest(); }
        if (seq < 1 || seq > chats.lastSequence(user,peer)) throw new BadRequest();
        readReceipts.mark(identities.id(user),identities.id(peer),seq);
        json(exchange,200,"{\"ok\":true" + readReceiptJson(user,peer) + "}");
    }

    private void messageAction(HttpExchange exchange, String action) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("message-action:" + user, 60, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}"); return;
        }
        Map<String, String> data = action.equals("edit") ? form(exchange,ChatStore.ARTICLE_BYTES * 3 + 4096) : form(exchange);
        String peer = checkedPeer(exchange, user, data.get("with"), true);
        if (peer == null) return;
        long seq, version;
        try {
            seq = Long.parseLong(data.getOrDefault("seq", "0"));
            version = Long.parseLong(data.getOrDefault("version", "0"));
        } catch (NumberFormatException error) { throw new BadRequest(); }
        if (seq < 1 || version < 0) throw new BadRequest();
        try {
            ChatStore.Message message;
            if (action.equals("edit")) {
                String text = data.get("text");
                if (text == null) {
                    json(exchange, 400, "{\"error\":\"invalid_message\"}"); return;
                }
                synchronized (relations) {
                    if (!relations.canMessage(user, peer)) {
                        String reason = relations.person(user, peer).blockedByMe() ? "blocked_by_you" : "message_unavailable";
                        json(exchange, 403, "{\"error\":" + quote(reason) + "}"); return;
                    }
                    message = chats.edit(user, peer, seq, version, text);
                }
            } else if (action.equals("retract")){message = chats.retract(user, peer, seq);removePin(user,peer,seq);}
            else message = chats.favorite(user, peer, seq);
            json(exchange, 200, "{\"message\":" + privateMessageJson(message,user,action.equals("favorite")?user:peer) + "}");
        } catch (ChatStore.ActionException error) {
            int status = error.reason.equals("message_not_yours") ? 403 : error.reason.equals("message_not_found") ? 404 : 409;
            json(exchange, status, "{\"error\":" + quote(error.reason) + "}");
        } catch (IllegalArgumentException error) {
            json(exchange,400,"{\"error\":" + quote(error.getMessage()) + "}");
        }
    }

    private void sendArticle(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("message:" + user,60,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> values = form(exchange,ChatStore.ARTICLE_BYTES * 3 + 4096);
        String peer = checkedPeer(exchange,user,values.get("to"),true); if (peer == null) return;
        String markdown = values.get("text"), id = values.get("id");
        ChatStore.Message message; boolean committed;
        try {
            synchronized (relations) {
                if (!relations.canMessage(user,peer)) {
                    String reason = relations.person(user,peer).blockedByMe() ? "blocked_by_you" : "message_unavailable";
                    json(exchange,403,"{\"error\":" + quote(reason) + "}"); return;
                }
                if (!AccountIdentities.validId(id)) throw new IllegalArgumentException("invalid_article");
                committed = chats.findAttachment(user,peer,id) == null;
                message = chats.sendArticle(user,peer,markdown,id);
            }
        } catch (IllegalArgumentException error) { json(exchange,400,"{\"error\":" + quote(error.getMessage()) + "}"); return; }
        if (committed && !user.equals(peer)) try { notifications.enqueue(identities.id(peer),identities.id(user),message.seq()); }
        catch (IOException error) { System.err.println("Notification enqueue failed: " + error.getClass().getSimpleName()); }
        json(exchange,committed ? 201 : 200,"{\"message\":" + messageJson(message) + "}");
    }

    private void sendMessage(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("message:" + user, 60, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}");
            return;
        }
        Map<String, String> data = form(exchange);
        String peer = data.get("to"), content = data.get("text");
        if (!AccountStore.validUsername(peer) || !accounts.exists(peer)) {
            json(exchange, 404, "{\"error\":\"user_not_found\"}");
            return;
        }
        if (content == null || content.isBlank() || content.codePointCount(0, content.length()) > 4000
                || content.getBytes(StandardCharsets.UTF_8).length > 16000) {
            json(exchange, 400, "{\"error\":\"invalid_message\"}");
            return;
        }
        ChatStore.Message message;
        synchronized (relations) {
            if (!relations.canMessage(user, peer)) {
                String reason = relations.person(user, peer).blockedByMe() ? "blocked_by_you" : "message_unavailable";
                json(exchange, 403, "{\"error\":" + quote(reason) + "}");
                return;
            }
            message = chats.send(user, peer, content.strip());
        }
        if (!user.equals(peer)) {
            try { notifications.enqueue(identities.id(peer),identities.id(user),message.seq()); }
            catch (IOException error) { System.err.println("Notification enqueue failed: " + error.getClass().getSimpleName()); }
        }
        json(exchange, 201, "{\"message\":" + messageJson(message) + "}");
    }

    private String uploadJson(Attachments.Upload u,ChatStore.Message message) {
        return uploadJson(u,message,null,null);
    }
    private String uploadJson(Attachments.Upload u,ChatStore.Message message,ChatStore.Message remark,String remarkError) {
        return "{\"id\":" + quote(u.id()) + ",\"offset\":" + u.offset() + ",\"size\":" + u.size()
            + ",\"state\":" + quote(u.state()) + ",\"chunkSize\":" + Attachments.CHUNK
            + ",\"message\":" + (message == null ? "null" : messageJson(message))
            + ",\"remark\":" + (remark == null ? "null" : messageJson(remark))
            + ",\"remarkError\":" + (remarkError == null ? "null" : quote(remarkError)) + "}";
    }
    private String targetPeer(String id){String user=identities.username(id);return user!=null?user:groups.exists(id)?GroupStore.peer(id):null;}
    private String targetId(String peer){return GroupStore.isPeer(peer)?peer.substring(6):identities.id(peer);}
    private boolean targetCanSend(String user,String peer,String kind,String topic){
        if(GroupStore.isPeer(peer)){groups.checkSend(peer.substring(6),identities.id(user),kind,topic);return true;}
        return peer!=null&&accounts.exists(peer)&&relations.canMessage(user,peer);
    }
    private String uploadTopic(String peer,String upload){return GroupStore.isPeer(peer)?groups.uploadTopic(peer.substring(6),upload):"general";}
    private void targetNotify(String target,String user,long seq){if(groups.exists(target))groupNotify(target,user,seq);else if(!target.equals(identities.id(user)))try{notifications.enqueue(target,identities.id(user),seq);}catch(IOException error){System.err.println("Notification enqueue pending");}}
    private ChatStore.Message uploadedMessage(Attachments.Upload u) throws IOException {
        String owner = identities.username(u.owner()),peer = targetPeer(u.peer());
        return owner == null || peer == null ? null : chats.findAttachment(owner,peer,u.id());
    }
    private void uploadStatus(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        try {
            synchronized (relations) { synchronized (attachments) {
                var u = attachments.get(identities.id(user),params(exchange).get("id"));
                var message = uploadedMessage(u);
                if (message != null && !u.state().equals("sent")) { attachments.sent(u); u = attachments.get(u.owner(),u.id()); }
                String peer = targetPeer(u.peer());
                var remark = message == null || peer == null ? null : chats.attachmentRemark(user,peer,u.id());
                json(exchange,200,uploadJson(u,message,remark,null));
            }}
        } catch (IllegalArgumentException error) { json(exchange,404,"{\"error\":\"upload_not_found\"}"); }
    }
    private void uploadAction(HttpExchange exchange,String action) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        String owner = identities.id(user);
        try {
            if (action.equals("chunk")) {
                Map<String,String> q = params(exchange);
                if (!"application/octet-stream".equalsIgnoreCase(exchange.getRequestHeaders().getFirst("Content-Type"))) throw new BadRequest();
                byte[] bytes = exchange.getRequestBody().readNBytes(Attachments.CHUNK+1);
                if (bytes.length > Attachments.CHUNK) throw new IllegalArgumentException("invalid_upload_chunk");
                var u = attachments.chunk(owner,q.get("id"),Long.parseLong(q.getOrDefault("offset","-1")),bytes);
                json(exchange,200,uploadJson(u,null)); return;
            }
            Map<String,String> f = form(exchange);
            if (action.equals("create")) {
                if (!rates.allow("upload-create:" + owner,20,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
                String peer = targetPeer(f.get("peerId")), topic=f.getOrDefault("topic","general");
                if (peer == null) { json(exchange,404,"{\"error\":\"user_not_found\"}"); return; }
                synchronized (relations) {
                    if(GroupStore.isPeer(peer))groups.member(peer.substring(6),owner);
                    else if (!relations.canMessage(user,peer)) { json(exchange,403,"{\"error\":\"message_unavailable\"}"); return; }
                    attachments.expire(identities,chats,groups);
                    var u = attachments.create(owner,targetId(peer),f.get("name"),Long.parseLong(f.getOrDefault("size","0")),"true".equals(f.get("asFile")),f.get("id"));
                    if(GroupStore.isPeer(peer)){groups.uploadTopic(peer.substring(6),u.id(),topic);targetCanSend(user,peer,u.kind(),topic);}
                    json(exchange,201,uploadJson(u,null)); return;
                }
            }
            String caption = action.equals("send") ? f.getOrDefault("caption","").strip() : "";
            if (caption.codePointCount(0,caption.length()) > 4000 || caption.getBytes(StandardCharsets.UTF_8).length > 16000)
                throw new IllegalArgumentException("invalid_message");
            if(action.equals("send")){
                var pending=attachments.get(owner,f.get("id"));
                if(uploadedMessage(pending)==null)attachments.inspectForSend(owner,pending.id());
            }
            ChatStore.Message message = null, remark = null; Attachments.Upload u;
            boolean committed = false, remarkCommitted = false; String remarkError = null;
            // Blocking, cancellation and final commit share these locks. A retry finds the durable record.
            synchronized (relations) {
                synchronized (attachments) {
                    u = attachments.get(owner,f.get("id")); message = uploadedMessage(u);
                    if (message != null) { attachments.sent(u); u = attachments.get(owner,u.id()); }
                    else if (action.equals("cancel")) u = attachments.cancel(owner,u.id());
                    else {
                        String peer = targetPeer(u.peer()),topic=uploadTopic(peer,u.id());
                        if (peer == null) throw new IllegalArgumentException("user_not_found");
                        u = attachments.ready(owner,u.id());
                        if (!targetCanSend(user,peer,u.kind(),topic)) { json(exchange,403,"{\"error\":\"message_unavailable\"}"); return; }
                        message = chats.sendAttachment(user,peer,"",u.attachment(),topic); committed = true;
                        // Once the message is durable, a metadata failure must not report a failed send.
                        try { attachments.sent(u); u = attachments.get(owner,u.id()); }
                        catch (IOException error) { System.err.println("Attachment index commit pending recovery"); }
                    }
                    String peer = targetPeer(u.peer());
                    if (message != null && peer != null) {
                        remark = chats.attachmentRemark(user,peer,u.id());
                        // Legacy messages already containing a caption are left intact.
                        if (action.equals("send") && !caption.isEmpty() && message.text().isEmpty() && remark == null) {
                            try {
                                if (!targetCanSend(user,peer,"text",uploadTopic(peer,u.id())))throw new IllegalArgumentException("message_unavailable");
                                remark = chats.sendAttachmentRemark(user,peer,caption,u.id(),uploadTopic(peer,u.id())); remarkCommitted = true;
                            } catch(IllegalArgumentException error){remarkError=error.getMessage();
                            } catch (IOException error) {
                                remarkError = "remark_save_failed";
                                System.err.println("Attachment sent, separate remark pending retry");
                            }
                        }
                    }
                }
            }
            if (committed) targetNotify(u.peer(),user,message.seq());
            if (remarkCommitted) targetNotify(u.peer(),user,remark.seq());
            json(exchange,200,uploadJson(u,message,remark,remarkError));
        } catch (IllegalArgumentException error) {
            String reason = error instanceof NumberFormatException ? "bad_request" : error.getMessage();
            if (reason == null) reason = "bad_request";
            int status = List.of("attachment_too_large","attachment_image_too_large","attachment_video_too_large","attachment_file_too_large").contains(reason) ? 413 : reason.equals("upload_not_found") ? 404
                : List.of("upload_offset","upload_closed","upload_incomplete","upload_already_sent").contains(reason) ? 409
                : reason.equals("attachment_storage_full") ? 507 : reason.equals("attachment_processing_busy") ? 503 : 400;
            json(exchange,status,"{\"error\":" + quote(reason) + "}");
        }
    }
    private String voiceJson(VoiceStore.Voice v,ChatStore.Message message) {
        return "{\"id\":"+quote(v.id())+",\"offset\":"+v.offset()+",\"size\":"+v.size()+",\"state\":"+quote(v.state())
            +",\"chunkSize\":"+VoiceStore.CHUNK+",\"message\":"+(message==null?"null":messageJson(message))+"}";
    }
    private ChatStore.Message voiceMessage(VoiceStore.Voice v) throws IOException {
        String owner=identities.username(v.owner()),peer=targetPeer(v.peer());
        return owner==null||peer==null?null:chats.findAttachment(owner,peer,v.id());
    }
    private void voiceStatus(HttpExchange exchange) throws IOException, BadRequest {
        String user=requireUser(exchange);if(user==null)return;
        try{synchronized(relations){synchronized(voices){var v=voices.get(identities.id(user),params(exchange).get("id"));var message=voiceMessage(v);
            if(message!=null)v=voices.sent(v,message.seq());json(exchange,200,voiceJson(v,message));}}}
        catch(IllegalArgumentException error){json(exchange,404,"{\"error\":\"voice_not_found\"}");}
    }
    private void voiceState(HttpExchange exchange) throws IOException, BadRequest {
        String user=requireUser(exchange);if(user==null)return;String peer=targetPeer(params(exchange).get("peerId"));
        if(GroupStore.isPeer(peer)){try{synchronized(relations){synchronized(groups){
            String uid=identities.id(user);var g=groups.member(peer.substring(6),uid);List<String> rows=new ArrayList<>();
            for(var v:voices.groupConversation(g.id)) {
                if(voices.groupSequence(v.id())<=g.members.get(uid).floor())continue;
                rows.add("{\"id\":"+quote(v.id())+",\"consumed\":"+voices.groupConsumed(v.id(),uid)+"}");
            }
            json(exchange,200,"{\"voices\":["+String.join(",",rows)+"]}");
        }}}catch(IllegalArgumentException error){json(exchange,403,"{\"error\":\"group_not_member\"}");}return;}
        if(peer==null){json(exchange,404,"{\"error\":\"user_not_found\"}");return;}
        List<String> rows=new ArrayList<>();for(var v:voices.conversation(identities.id(user),identities.id(peer)))rows.add("{\"id\":"+quote(v.id())+",\"consumed\":"+v.consumed()+"}");
        json(exchange,200,"{\"voices\":["+String.join(",",rows)+"]}");
    }
    private void voiceAction(HttpExchange exchange,String action) throws IOException, BadRequest {
        String user=requireUser(exchange);if(user==null)return;String owner=identities.id(user);
        try{
            if(action.equals("chunk")){
                Map<String,String> q=params(exchange);if(!"application/octet-stream".equalsIgnoreCase(exchange.getRequestHeaders().getFirst("Content-Type")))throw new BadRequest();
                byte[] bytes=exchange.getRequestBody().readNBytes(VoiceStore.CHUNK+1);
                var v=voices.chunk(owner,q.get("id"),Long.parseLong(q.getOrDefault("offset","-1")),bytes);json(exchange,200,voiceJson(v,null));return;
            }
            Map<String,String> f=form(exchange);
            if(action.equals("create")){
                if(!rates.allow("voice-create:"+owner,20,60)){json(exchange,429,"{\"error\":\"rate_limited\"}");return;}
                String peer=targetPeer(f.get("peerId")),topic=f.getOrDefault("topic","general");if(peer==null)throw new IllegalArgumentException("user_not_found");
                if(!List.of("true","false").contains(f.get("once")))throw new BadRequest();
                synchronized(relations){if(!targetCanSend(user,peer,"true".equals(f.get("once"))?"voice-once":"voice",topic)){json(exchange,403,"{\"error\":\"message_unavailable\"}");return;}
                    voices.expire(identities,chats,groups);var v=voices.create(f.get("id"),owner,targetId(peer),f.get("type"),Long.parseLong(f.getOrDefault("size","0")),Long.parseLong(f.getOrDefault("duration","0")),f.get("waveform"),"true".equals(f.get("once")));if(GroupStore.isPeer(peer))groups.uploadTopic(peer.substring(6),v.id(),topic);json(exchange,201,voiceJson(v,null));return;}
            }
            // Container indexing can take time on a long recording; do not hold the relationship lock while doing it.
            if(action.equals("send")){var candidate=voices.get(owner,f.get("id"));if(voiceMessage(candidate)==null)voices.ready(candidate);}
            ChatStore.Message message=null;VoiceStore.Voice v;boolean committed=false;
            synchronized(relations){synchronized(groups){synchronized(voices){
                v=voices.get(owner,f.get("id"));message=voiceMessage(v);
                if(message!=null)v=voices.sent(v,message.seq());
                else if(action.equals("cancel"))v=voices.cancel(owner,v.id());
                else{String peer=targetPeer(v.peer()),topic=uploadTopic(peer,v.id());if(peer==null)throw new IllegalArgumentException("user_not_found");
                    if(!targetCanSend(user,peer,v.once()?"voice-once":"voice",topic)){json(exchange,403,"{\"error\":\"message_unavailable\"}");return;}
                    if(!v.state().equals("uploading")||v.offset()!=v.size())throw new IllegalArgumentException("upload_closed");
                    // Persist the audience before the chat commit. Retries and
                    // later joins cannot change who can claim this recording.
                    if(v.once()&&GroupStore.isPeer(peer))voices.prepareGroup(v,groups.member(peer.substring(6),owner).members.keySet());
                    message=chats.sendAttachment(user,peer,"",v.attachment(),topic);committed=true;
                    try{v=voices.sent(v,message.seq());}catch(IOException error){System.err.println("Voice index commit pending recovery");}
                }
            }}}
            if(committed)targetNotify(v.peer(),user,message.seq());
            json(exchange,200,voiceJson(v,message));
        }catch(IllegalArgumentException error){String reason=error instanceof NumberFormatException?"bad_request":error.getMessage();if(reason==null)reason="bad_request";
            int status=reason.equals("attachment_storage_full")?507:reason.equals("voice_not_found")?404:List.of("upload_offset","upload_closed","upload_incomplete","upload_already_sent").contains(reason)?409:400;
            json(exchange,status,"{\"error\":"+quote(reason)+"}");}
    }
    private void handleOnceVoice(HttpExchange exchange) throws IOException {
        var gate=lifecycle.readLock();java.nio.channels.FileChannel channel=null;VoiceStore.Voice played=null;
        gate.lock();try{
            commonHeaders(exchange);
            if(unavailable){json(exchange,503,"{\"error\":\"account_update_pending\"}");return;}
            if(!origin.equals(exchange.getRequestHeaders().getFirst("Origin"))){json(exchange,403,"{\"error\":\"origin_rejected\"}");return;}
            String user=requireUser(exchange);if(user==null)return;
            if(!identities.id(user).equals(exchange.getRequestHeaders().getFirst("X-Chawe-Identity"))){json(exchange,401,"{\"error\":\"unauthorized\"}");return;}
            if(!Long.toString(identities.generation()).equals(exchange.getRequestHeaders().getFirst("X-Chawe-Directory-Version"))){json(exchange,409,"{\"error\":\"directory_changed\"}");return;}
            Map<String,String> q=params(exchange);String peer=targetPeer(q.get("peerId")),uid=identities.id(user);
            if(peer==null)throw new IllegalArgumentException("voice_not_found");
            synchronized(relations){synchronized(groups){
                boolean group=GroupStore.isPeer(peer);var g=group?groups.member(peer.substring(6),uid):null;
                var message=chats.notificationMessage(user,peer,Long.parseLong(q.getOrDefault("seq","0")));
                if(message.deleted()||message.attachment()==null||!message.attachment().kind().equals("voice-once")||!message.attachment().id().equals(q.get("id"))
                    ||group&&message.seq()<=g.members.get(uid).floor())throw new IllegalArgumentException("voice_not_found");
                synchronized(voices){var v=voices.find(q.get("id"));
                    if(!v.owner().equals(identities.id(message.sender()))||!v.peer().equals(group?g.id:uid))throw new IllegalArgumentException("voice_once_only");
                    if(group?voices.groupConsumed(v.id(),uid):v.consumed())throw new IllegalArgumentException("voice_consumed");
                    // Recover a chat commit whose metadata write failed before a restart.
                    v=voices.sent(v,message.seq());channel=java.nio.channels.FileChannel.open(voices.path(v.id()),java.nio.file.StandardOpenOption.READ);
                    if(channel.size()!=v.size())throw new IllegalArgumentException("voice_not_found");
                    played=group?voices.consumeGroup(v.id(),uid):voices.consume(v.id(),uid);
                }
            }}
            var h=exchange.getResponseHeaders();h.set("Content-Type",played.type());h.set("Content-Disposition","inline");h.set("Accept-Ranges","none");h.set("Cross-Origin-Resource-Policy","same-origin");
        }catch(ChatStore.ActionException | IllegalArgumentException | BadRequest error){String reason=error instanceof IllegalArgumentException?error.getMessage():"voice_not_found";
            json(exchange,"voice_consumed".equals(reason)?410:403,"{\"error\":"+quote(reason==null?"voice_not_found":reason)+"}");}
        catch(Exception error){json(exchange,500,"{\"error\":\"server_error\"}");}
        finally{gate.unlock();if(played==null){if(channel!=null){channel.close();channel=null;}exchange.close();}}
        if(played==null)return;
        try{exchange.sendResponseHeaders(200,played.size());long left=played.size();var b=java.nio.ByteBuffer.allocate(64*1024);
            while(left>0){b.clear();b.limit((int)Math.min(left,b.capacity()));int n=channel.read(b);if(n<0)throw new IOException("Voice ended early");exchange.getResponseBody().write(b.array(),0,n);left-=n;}}
        catch(IOException disconnected){/* Consumed voices are not replayed after a lost connection. */}
        finally{channel.close();try{voices.destroy(played.id());}catch(IOException error){System.err.println("Consumed voice cleanup deferred until restart");}exchange.close();}
    }
    private FileTransfer attachmentFile(HttpExchange exchange) throws IOException, BadRequest {
        Map<String,String> q = params(exchange); String user = identities.username(q.get("accountId")),peer = targetPeer(q.get("peerId"));
        if (user == null || peer == null || session(exchange,user) == null) { json(exchange,401,"{\"error\":\"unauthorized\"}"); return null; }
        ChatStore.Message message;
        try { message = chats.notificationMessage(user,peer,Long.parseLong(q.getOrDefault("seq","0"))); }
        catch (ChatStore.ActionException | NumberFormatException error) { json(exchange,404,"{\"error\":\"attachment_not_found\"}"); return null; }
        var a = message.attachment();
        if(GroupStore.isPeer(peer)){try{var g=groups.member(peer.substring(6),identities.id(user));if(message.seq()<=g.members.get(identities.id(user)).floor())throw new IllegalArgumentException();}catch(IllegalArgumentException error){json(exchange,403,"{\"error\":\"group_not_member\"}");return null;}}
        if (message.deleted() || a == null || !a.id().equals(q.get("id"))) { json(exchange,404,"{\"error\":\"attachment_not_found\"}"); return null; }
        if(a.kind().equals("voice-once")){json(exchange,403,"{\"error\":\"voice_once_only\"}");return null;}
        if(a.kind().equals("article")){json(exchange,404,"{\"error\":\"attachment_not_found\"}");return null;}
        boolean voice=a.kind().equals("voice");
        Path file = voice ? voices.playable(a.id()) : attachments.path(a.id());
        if (!Files.isRegularFile(file) || (!voice && Files.size(file) != a.size()) || voice && (!Files.isRegularFile(voices.path(a.id())) || Files.size(voices.path(a.id()))!=a.size())) { json(exchange,404,"{\"error\":\"attachment_not_found\"}"); return null; }
        long fileSize=Files.size(file);
        boolean download = exchange.getRequestURI().getPath().equals("/api/attachments/download") || "1".equals(q.get("download")) || a.kind().equals("file");
        var h = exchange.getResponseHeaders();
        h.set("Content-Type",download ? "application/octet-stream" : a.type()); h.set("Accept-Ranges","bytes");
        if (!voice && (a.type().startsWith("image/") || a.type().startsWith("video/")))
            h.set("X-Chawe-Cache-Media",a.type().startsWith("image/") ? "image" : "video");
        h.set("Content-Disposition",(download ? "attachment" : "inline") + "; filename=\"attachment\"; filename*=UTF-8''"
            + java.net.URLEncoder.encode(a.name(),StandardCharsets.UTF_8).replace("+","%20"));
        h.set("Cross-Origin-Resource-Policy","same-origin");
        long start = 0,end = fileSize-1; int status = 200;
        String range = exchange.getRequestHeaders().getFirst("Range");
        if (range != null) {
            try {
                if (!range.matches("bytes=[0-9]*-[0-9]*") || range.equals("bytes=-")) throw new IllegalArgumentException();
                String[] f = range.substring(6).split("-",-1);
                if (f[0].isEmpty()) { long suffix = Long.parseLong(f[1]); if (suffix < 1) throw new IllegalArgumentException(); start = Math.max(0,fileSize-suffix); }
                else { start = Long.parseLong(f[0]); if (!f[1].isEmpty()) end = Math.min(end,Long.parseLong(f[1])); }
                if (start < 0 || start > end || start >= fileSize) throw new IllegalArgumentException();
            } catch (IllegalArgumentException error) { h.set("Content-Range","bytes */" + fileSize); exchange.sendResponseHeaders(416,-1); return null; }
            status = 206; h.set("Content-Range","bytes " + start + "-" + end + "/" + fileSize);
        }
        return new FileTransfer(file,start,end-start+1,status);
    }
    private record FileTransfer(Path file,long start,long count,int status) { }
    private void handleAttachmentFile(HttpExchange exchange) throws IOException {
        FileTransfer transfer = null;
        var gate = lifecycle.readLock(); gate.lock();
        try {
            commonHeaders(exchange);
            if (unavailable) json(exchange,503,"{\"error\":\"account_update_pending\"}");
            else transfer = attachmentFile(exchange);
        } catch (BadRequest | IllegalArgumentException error) { json(exchange,400,"{\"error\":\"bad_request\"}"); }
        catch (Exception error) { json(exchange,500,"{\"error\":\"server_error\"}"); }
        finally { gate.unlock(); }
        // Authorization is decided before starting the transfer. Slow downloads do not hold the account rename gate.
        try {
            if (transfer == null) return;
            if (exchange.getRequestMethod().equals("HEAD")) {
                exchange.getResponseHeaders().set("Content-Length",Long.toString(transfer.count()));
                exchange.sendResponseHeaders(transfer.status(),-1); return;
            }
            exchange.sendResponseHeaders(transfer.status(),transfer.count());
            long remaining = transfer.count();
            try (var input = java.nio.channels.FileChannel.open(transfer.file(),java.nio.file.StandardOpenOption.READ)) {
                input.position(transfer.start()); var buffer = java.nio.ByteBuffer.allocate(64*1024);
                while (remaining > 0) {
                    buffer.clear(); buffer.limit((int)Math.min(buffer.capacity(),remaining)); int read = input.read(buffer);
                    if (read < 0) throw new IOException("Attachment ended before expected size");
                    exchange.getResponseBody().write(buffer.array(),0,read); remaining -= read;
                }
            }
        } catch (IOException disconnected) { /* Client seeking, cancelling, or closing its player ends the transfer. */ }
        finally { exchange.close(); }
    }

    private String notificationBrowser(HttpExchange exchange,String user) throws IOException {
        synchronized (browserAccounts) {
            String token = browserToken(exchange);
            if (browserAccounts.access(token) == null) {
                token = browserAccounts.remember(token,null,user); setBrowserCookie(exchange,token);
            }
            return Sessions.hash(token);
        }
    }
    private String notificationJson(String browser,String id) {
        var preference = notifications.preference(browser,id);
        return "{\"confirmed\":" + preference.confirmed() + ",\"enabled\":" + preference.enabled() + ",\"preview\":" + preference.preview()
            + ",\"subscribed\":" + notifications.subscribed(browser) + ",\"pushStatus\":" + notifications.deliveryStatus(browser)
            + ",\"publicKey\":" + quote(notifications.transport.publicKey()) + "}";
    }
    private void notificationEvents(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        String browser = notificationBrowser(exchange,user);
        long since, now = java.time.Instant.now().getEpochSecond();
        try { since = Long.parseLong(params(exchange).getOrDefault("since","0")); }
        catch (NumberFormatException error) { throw new BadRequest(); }
        if (since < 0 || since > now+60) throw new BadRequest();
        // The initial call establishes a baseline instead of notifying about old messages.
        List<String> rows = new ArrayList<>();
        if (since > 0) for (var e : notifications.recent(browser,since)) {
            if (pushAuthorized(browser,e.recipient())) rows.add("{\"event\":" + quote(e.id()) + ",\"accountId\":" + quote(e.recipient())
                + ",\"peerId\":" + quote(e.sender()) + "}");
        }
        json(exchange,200,"{\"cursor\":" + now + ",\"events\":[" + String.join(",",rows) + "]}");
    }
    private void notificationSettings(HttpExchange exchange) throws IOException {
        String user = requireUser(exchange); if (user == null) return;
        json(exchange,200,notificationJson(notificationBrowser(exchange,user),identities.id(user)));
    }
    private void saveNotifications(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange); if (user == null) return;
        if (!rates.allow("notifications:" + identities.id(user),30,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> values = form(exchange); String browser = notificationBrowser(exchange,user);
        if (!List.of("true","false").contains(values.getOrDefault("enabled","")) || !List.of("true","false").contains(values.getOrDefault("preview",""))) throw new BadRequest();
        try {
            notifications.save(browser,identities.id(user),Boolean.parseBoolean(values.get("enabled")),Boolean.parseBoolean(values.get("preview")),
                values.get("endpoint"),values.get("p256dh"),values.get("auth"));
            json(exchange,200,notificationJson(browser,identities.id(user)));
        } catch (IllegalArgumentException error) { json(exchange,400,"{\"error\":" + quote(error.getMessage() == null ? "invalid_push_subscription" : error.getMessage()) + "}"); }
    }
    private void refreshNotificationSubscription(HttpExchange exchange) throws IOException, BadRequest {
        String token = browserToken(exchange);
        BrowserAccounts.Access access = browserAccounts.access(token);
        if (access == null || access.users().stream().noneMatch(accounts::exists)) { json(exchange,401,"{\"error\":\"unauthorized\"}"); return; }
        String browser = Sessions.hash(token);
        if (!rates.allow("push-refresh:" + browser,10,60)) { json(exchange,429,"{\"error\":\"rate_limited\"}"); return; }
        Map<String,String> values = form(exchange);
        try { notifications.subscribe(browser,values.get("endpoint"),values.get("p256dh"),values.get("auth")); json(exchange,200,"{\"ok\":true}"); }
        catch (IllegalArgumentException error) { json(exchange,400,"{\"error\":\"invalid_push_subscription\"}"); }
    }
    private boolean pushAuthorized(String browser,String id) {
        String user = identities.username(id); return user != null && browserAccounts.authorizesHash(browser,user);
    }
    private ChatStore.Message unreadNotification(PushNotifications.Event event,String user,String peer) throws IOException {
        if(peer==null)return null;
        try {
            var message=chats.notificationMessage(user,peer,event.seq());String uid=identities.id(user);long through;
            if(message.deleted()||message.sender().equals(user))return null;
            if(GroupStore.isPeer(peer)) {
                var g=groups.member(peer.substring(6),uid);
                through=Math.max(g.members.get(uid).floor(),readReceipts.through(uid,groupReceiptId(g,message.topic())));
            } else {
                if(!message.sender().equals(peer))return null;
                through=readReceipts.through(uid,identities.id(peer));
            }
            return message.seq()>through?message:null;
        } catch(ChatStore.ActionException|IllegalArgumentException error){return null;}
    }
    private long notificationUnread(String browser) throws IOException {
        long count=0;
        for(String uid:notifications.enabledAccounts(browser)) {
            if(!pushAuthorized(browser,uid))continue;
            String user=identities.username(uid);if(user==null||!accounts.exists(user))continue;
            for(var chat:chats.chats(user,""))if(!chat.peer().equals(user)&&accounts.exists(chat.peer()))
                count+=chats.unreadCount(user,chat.peer(),0,Map.of("*",readReceipts.through(uid,identities.id(chat.peer()))));
            for(var g:groups.list(uid,"",false)) {
                Map<String,Long> through=new java.util.HashMap<>();
                if(g.topicsEnabled)for(String topic:g.topics.keySet())through.put(topic,readReceipts.through(uid,groupReceiptId(g,topic)));
                else through.put("*",readReceipts.through(uid,g.id));
                count+=chats.unreadCount(user,GroupStore.peer(g.id),g.members.get(uid).floor(),through);
            }
        }
        return count;
    }
    private void notificationMessage(HttpExchange exchange) throws IOException, BadRequest {
        var query=params(exchange);String id = query.get("event");long wait;
        try {wait=Long.parseLong(query.getOrDefault("wait","0"));}catch(NumberFormatException error){throw new BadRequest();}
        if(wait<0||wait>15000)throw new BadRequest();
        if (!AccountIdentities.validId(id)) throw new BadRequest();
        PushNotifications.Event event = notifications.get(id); String token = browserToken(exchange);
        String user = event == null ? null : identities.username(event.recipient());
        if (event == null || user == null || !Sessions.validToken(token) || !Sessions.hash(token).equals(event.browser())
            || !browserAccounts.authorizesHash(event.browser(),user) || !notifications.preference(event.browser(),event.recipient()).enabled()) {
            json(exchange,403,"{\"error\":\"notification_unavailable\"}"); return;
        }
        String peer = targetPeer(event.sender());ChatStore.Message message=null;long count=0,delay;String name="";
        synchronized(relations){synchronized(groups){synchronized(readReceipts){
            delay=notifications.defer(event,wait);
            if(delay==0){
                message=unreadNotification(event,user,peer);
                if(message==null){notifications.discard(event,false);json(exchange,404,"{\"error\":\"notification_unavailable\"}");return;}
                count=notificationUnread(event.browser());notifications.claim(event);
                name=GroupStore.isPeer(peer)?groups.get(peer.substring(6)).name:relations.person(user,peer).alias();
            }
        }}}
        String identity="{\"event\":"+quote(event.id())+",\"accountId\":"+quote(event.recipient())+",\"peerId\":"+quote(event.sender());
        if(delay!=0){
            // Older workers do not recognize the deferred payload; use their existing quiet-skip path.
            if(!query.containsKey("wait"))json(exchange,403,"{\"error\":\"notification_deferred\"}");
            else json(exchange,200,identity+",\"suppressed\":true,\"retryAfter\":"+Math.max(0,delay)+"}");
            return;
        }
        boolean group=GroupStore.isPeer(peer);
        boolean preview = notifications.preference(event.browser(),event.recipient()).preview();
        if (name.isEmpty()&&!group) name = userProfiles.nickname(peer);
        if (name.isEmpty()) name = peer;
        String title = preview ? name + " · chawe" : "chawe";
        String text = preview ? ChatStore.preview(message).replaceAll("[\\r\\n]+"," ") : "你收到了一条新消息";
        if(count>1){title="chawe";text="有 "+count+" 条未读消息";}
        if (text.codePointCount(0,text.length()) > 120) text = text.substring(0,text.offsetByCodePoints(0,120)) + "…";
        json(exchange,200,"{\"event\":" + quote(event.id()) + ",\"accountId\":" + quote(event.recipient()) + ",\"peerId\":" + quote(event.sender())
            + ",\"unread\":"+count+",\"title\":" + quote(title) + ",\"body\":" + quote(text) + "}");
    }
    private void dispatchPush() {
        PushNotifications.Event event = null; PushNotifications.Subscription subscription = null; int code = 204;
        var gate = lifecycle.readLock();
        try {
            gate.lock();
            try {
                if (unavailable) return;
                long now = java.time.Instant.now().getEpochSecond();
                if (now-lastPushMaintenance >= 3600) { notifications.prune(this::pushAuthorized); lastPushMaintenance = now; }
                event = notifications.due(); if (event == null) return;
                String user = identities.username(event.recipient());
                if (user != null && event.created() > java.time.Instant.now().getEpochSecond()-3600 && browserAccounts.authorizesHash(event.browser(),user)) subscription = notifications.target(event);
                if(subscription!=null)synchronized(relations){synchronized(groups){if(unreadNotification(event,user,targetPeer(event.sender()))==null)subscription=null;}}
                if(subscription==null){notifications.discard(event,true);return;}
            } finally { gate.unlock(); }
            if (subscription != null) {
                String payload = "{\"event\":" + quote(event.id()) + ",\"accountId\":" + quote(event.recipient()) + ",\"peerId\":" + quote(event.sender()) + "}";
                try { code = notifications.transport.send(subscription.endpoint(),subscription.key(),subscription.auth(),payload); }
                catch (IOException | java.security.GeneralSecurityException error) { code = 0; System.err.println("Browser push delivery failed: " + error.getClass().getSimpleName()); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); return; }
                if (code < 200 || code >= 300) System.err.println("Browser push rejected: host="
                    + java.net.URI.create(subscription.endpoint()).getHost() + " status=" + code);
            }
            notifications.complete(event,code);
        } catch (Exception error) { System.err.println("Notification worker failed: " + error.getClass().getSimpleName()); }
    }

    private String checkedPeer(HttpExchange exchange, String user, String peer, boolean allowSelf) throws IOException {
        if (!AccountStore.validUsername(peer) || !accounts.exists(peer)) {
            json(exchange, 404, "{\"error\":\"user_not_found\"}");
            return null;
        }
        if (!allowSelf && user.equals(peer)) {
            json(exchange, 400, "{\"error\":\"invalid_user\"}");
            return null;
        }
        return peer;
    }

    private String privateReactionState(String user,String peer,ChatStore.Message message) {
        String uid=identities.id(user),key=PinStore.key(uid,identities.id(peer),false);
        Map<String,Long> counts=new java.util.LinkedHashMap<>();String mine="";
        if(!message.deleted())for(var entry:reactions.get(key,message.seq()).entrySet()) {
            counts.merge(entry.getValue(),1L,Long::sum);if(entry.getKey().equals(uid))mine=entry.getValue();
        }
        List<String> rows=new ArrayList<>();
        for(String emoji:GroupStore.EMOJI)if(counts.containsKey(emoji))rows.add("{\"emoji\":"+quote(emoji)+",\"count\":"+counts.get(emoji)+",\"mine\":"+emoji.equals(mine)+"}");
        return "{\"seq\":"+message.seq()+",\"reactions\":["+String.join(",",rows)+"]}";
    }
    private String privateMessageJson(ChatStore.Message message,String user,String peer) {
        String base=messageJson(message),state=privateReactionState(user,peer,message);
        return base.substring(0,base.length()-1)+","+state.substring(state.indexOf(',')+1);
    }
    private void reactionApi(HttpExchange exchange,boolean write) throws IOException,BadRequest {
        String user=requireUser(exchange);if(user==null)return;
        Map<String,String> f=write?form(exchange):params(exchange);String peer=f.get("peer");
        if(peer==null||!GroupStore.isPeer(peer)&&!AccountStore.validUsername(peer))throw new BadRequest();
        String uid=identities.id(user),pid=targetId(peer);if(pid==null){json(exchange,404,"{\"error\":\"user_not_found\"}");return;}
        if(write&&!rates.allow("reaction:"+uid,120,60)){json(exchange,429,"{\"error\":\"rate_limited\"}");return;}
        try{synchronized(relations){synchronized(groups){
            var group=GroupStore.isPeer(peer)?groups.member(pid,uid):null;
            long floor=group==null?0:group.members.get(uid).floor();String topic=f.getOrDefault("topic","general");
            if(write) {
                if(f.get("emoji")==null||!GroupStore.EMOJI.contains(f.get("emoji")))throw new IllegalArgumentException("invalid_reaction");
                long seq=Long.parseLong(f.getOrDefault("seq","0"));var message=chats.notificationMessage(user,peer,seq);
                if(message.seq()<=floor||message.deleted())throw new IllegalArgumentException("message_retracted");
                if(group!=null){groups.react(pid,uid,seq,f.get("emoji"));group=groups.get(pid);}
                else {
                    if(!relations.canMessage(user,peer))throw new IllegalArgumentException("message_unavailable");
                    reactions.toggle(uid,pid,seq,f.get("emoji"));
                }
                json(exchange,200,"{\"message\":"+(group==null?privateMessageJson(message,user,peer):groupMessageJson(group,user,message))+"}");return;
            }
            var sequences=new java.util.TreeSet<Long>();String csv=f.getOrDefault("seqs","");
            if(!csv.isEmpty())for(String seq:csv.split(",",-1))if(!sequences.add(Long.parseLong(seq)))throw new BadRequest();
            List<String> rows=new ArrayList<>();for(var message:chats.reactionMessages(user,peer,sequences)) {
                if(message.seq()<=floor||group!=null&&group.topicsEnabled&&!message.topic().equals(topic))continue;
                rows.add(group==null?privateReactionState(user,peer,message):groupMessageState(group,user,message));
            }
            json(exchange,200,"{\"states\":["+String.join(",",rows)+"]}");
        }}}catch(ChatStore.ActionException error){json(exchange,404,"{\"error\":"+quote(error.reason)+"}");}
        catch(IllegalArgumentException error){String reason=error instanceof NumberFormatException?"invalid_reaction":error.getMessage();json(exchange,400,"{\"error\":"+quote(reason==null?"invalid_reaction":reason)+"}");}
    }
    private void removePin(String user,String peer,long seq){try{pins.set(PinStore.key(identities.id(user),targetId(peer),GroupStore.isPeer(peer)),seq,false);}catch(IOException error){System.err.println("Pin cleanup pending");}}
    private void pinApi(HttpExchange exchange,boolean write) throws IOException,BadRequest {
        String user=requireUser(exchange);if(user==null)return;
        Map<String,String> f=write?form(exchange):params(exchange);String peer=f.get("peer");
        if(peer==null||!GroupStore.isPeer(peer)&&!AccountStore.validUsername(peer)){json(exchange,400,"{\"error\":\"user_not_found\"}");return;}
        String uid=identities.id(user),pid=targetId(peer);if(pid==null){json(exchange,404,"{\"error\":\"user_not_found\"}");return;}
        if(write&&!rates.allow("pins:"+uid,120,60)){json(exchange,429,"{\"error\":\"rate_limited\"}");return;}
        try{synchronized(relations){synchronized(groups){
            GroupStore.Group group=GroupStore.isPeer(peer)?groups.member(pid,uid):null;
            long floor=group==null?0:group.members.get(uid).floor();String topic=f.getOrDefault("topic","general");
            String key=PinStore.key(uid,pid,group!=null);
            if(write){
                long seq=Long.parseLong(f.getOrDefault("seq","0"));String state=f.get("pinned");if(!List.of("true","false").contains(state))throw new BadRequest();
                if(group==null){if(!accounts.exists(peer)||!relations.canMessage(user,peer))throw new IllegalArgumentException("message_unavailable");}
                else if(!GroupStore.manages(group,uid,"pinMessages")&&!GroupStore.permits(group,uid,"pinMessages"))throw new IllegalArgumentException("group_permission_denied");
                var message=chats.notificationMessage(user,peer,seq);
                if(message.seq()<=floor)throw new IllegalArgumentException("message_not_found");
                if(state.equals("true")&&(message.deleted()||message.attachment()!=null&&message.attachment().kind().equals("voice-once")))throw new IllegalArgumentException("message_retracted");
                pins.set(key,seq,state.equals("true"));
            }
            PinStore.Pins stored=pins.get(key);List<String> rows=new ArrayList<>();
            for(long seq:stored.sequences()){if(seq<=floor)continue;ChatStore.Message message;
                try{message=chats.notificationMessage(user,peer,seq);}catch(ChatStore.ActionException error){continue;}
                if(message.deleted()||group!=null&&group.topicsEnabled&&!message.topic().equals(topic))continue;
                rows.add(group==null?privateMessageJson(message,user,peer):groupMessageJson(group,user,message));
            }
            boolean canPin=group==null?relations.canMessage(user,peer):GroupStore.manages(group,uid,"pinMessages")||GroupStore.permits(group,uid,"pinMessages");
            json(exchange,200,"{\"version\":"+stored.version()+",\"canPin\":"+canPin+",\"messages\":["+String.join(",",rows)+"]}");
        }}}catch(ChatStore.ActionException error){json(exchange,409,"{\"error\":"+quote(error.reason)+"}");}
        catch(IllegalArgumentException error){String reason=error.getMessage()==null?"bad_request":error.getMessage();json(exchange,reason.equals("group_not_member")||reason.equals("group_permission_denied")?403:400,"{\"error\":"+quote(reason)+"}");}
    }
    private String groupJson(GroupStore.Group g,String user) {
        String uid=identities.id(user);GroupStore.Member member=g.members.get(uid);
        String avatarUrl=g.avatar.isEmpty()?"":"/api/groups/avatar?"+"id="+g.id+"&accountId="+uid+"&v="+g.avatar;
        StringBuilder out=new StringBuilder("{\"kind\":\"group\",\"username\":"+quote(GroupStore.peer(g.id))+",\"id\":"+quote(g.id)
            +",\"name\":"+quote(g.name)+",\"displayName\":"+quote(g.name)+",\"description\":"+quote(g.description)
            +",\"type\":"+quote(g.type)+",\"handle\":"+quote(g.handle)+",\"ownerId\":"+quote(g.owner)+",\"version\":"+g.version
            +",\"avatarUrl\":"+quote(avatarUrl)+",\"avatarVersion\":"+quote(g.avatar)+",\"memberCount\":"+g.members.size()
            +",\"joined\":"+(member!=null)+",\"canMessage\":"+(member!=null)+",\"myRole\":"+quote(member==null?"":member.role())
            +",\"superAdmin\":"+GroupStore.supreme(g,uid)
            +",\"historyFloor\":"+(member==null?0:member.floor())+",\"history\":"+g.history+",\"topicsEnabled\":"+g.topicsEnabled
            +",\"reactionMode\":"+quote(g.reactionMode)+",\"allowedReactions\":"+stringArray(g.allowedReactions)+",\"permissions\":"+stringArray(g.permissions)
            +",\"myRights\":"+stringArray(member==null?java.util.Set.of():member.rights())+",\"members\":[");
        for(var m:g.members.values()){
            String name=identities.username(m.id());if(name==null)continue;
            if(out.charAt(out.length()-1)!='[')out.append(',');String person=personJson(user,name);
            out.append(person,0,person.length()-1).append(",\"role\":").append(quote(m.role())).append(",\"rights\":").append(stringArray(m.rights())).append('}');
        }
        out.append("],\"topics\":[");for(var t:g.topics.values()){if(out.charAt(out.length()-1)!='[')out.append(',');out.append("{\"id\":").append(quote(t.id())).append(",\"title\":").append(quote(t.title())).append(",\"closed\":").append(t.closed()).append('}');}
        out.append("],\"invites\":[");
        if(GroupStore.manages(g,uid,"inviteUsers"))for(var invite:g.invites.values()){
            if(out.charAt(out.length()-1)!='[')out.append(',');out.append("{\"token\":").append(quote(invite.token())).append(",\"created\":").append(invite.created())
                .append(",\"expires\":").append(invite.expires()).append(",\"limit\":").append(invite.limit()).append(",\"used\":").append(invite.used()).append(",\"revoked\":").append(invite.revoked()).append('}');
        }
        return out.append("]}").toString();
    }
    private static String stringArray(java.util.Collection<String> values){return "["+values.stream().sorted().map(HttpApp::quote).collect(java.util.stream.Collectors.joining(","))+"]";}
    private String groupMessageJson(GroupStore.Group g,String user,ChatStore.Message message){
        String base=messageJson(message,identities.id(user)),state=groupMessageState(g,user,message);
        return base.substring(0,base.length()-1)+",\"topic\":"+quote(message.topic())+","+state.substring(state.indexOf(',')+1);
    }
    private String groupMessageState(GroupStore.Group g,String user,ChatStore.Message message){
        Map<String,Long> counts=new java.util.LinkedHashMap<>();String uid=identities.id(user),mine="";boolean read=false;
        String author=identities.id(message.sender()),receipt=groupReceiptId(g,message.topic());
        for(var member:g.members.values())if(!member.id().equals(author)&&message.seq()>member.floor()&&readReceipts.through(member.id(),receipt)>=message.seq()){read=true;break;}
        if(!message.deleted()&&!g.reactionMode.equals("none"))for(var reaction:g.reactions.getOrDefault(message.seq(),Map.of()).entrySet()){
            if(g.reactionMode.equals("selected")&&!g.allowedReactions.contains(reaction.getValue()))continue;
            counts.merge(reaction.getValue(),1L,Long::sum);if(reaction.getKey().equals(uid))mine=reaction.getValue();
        }
        List<String> rows=new ArrayList<>();for(var entry:counts.entrySet())rows.add("{\"emoji\":"+quote(entry.getKey())+",\"count\":"+entry.getValue()+",\"mine\":"+entry.getKey().equals(mine)+"}");
        return "{\"seq\":"+message.seq()+",\"read\":"+read+",\"reactions\":["+String.join(",",rows)+"]}";
    }
    private static String groupReceiptId(GroupStore.Group g,String topic){
        if(!g.topicsEnabled)return g.id;
        try{return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(("group-read:"+g.id+":"+topic).getBytes(StandardCharsets.UTF_8))).substring(0,32);}
        catch(java.security.NoSuchAlgorithmException error){throw new IllegalStateException(error);}
    }
    private String groupReceipts(GroupStore.Group g,String user,String topic){
        String uid=identities.id(user),key=groupReceiptId(g,topic);long peerRead=0;for(String id:g.members.keySet())if(!id.equals(uid))peerRead=Math.max(peerRead,readReceipts.through(id,key));
        return ",\"readThrough\":"+readReceipts.through(uid,key)+",\"peerReadThrough\":"+peerRead;
    }
    private List<String> groupContactIds(String user,String value) {
        if(value==null||value.isEmpty())return List.of();java.util.LinkedHashSet<String> result=new java.util.LinkedHashSet<>();
        synchronized(relations){for(String id:value.split(",",-1)){
            String peer=identities.username(id);if(peer==null||peer.equals(user)||!relations.person(user,peer).contact()||!relations.canMessage(user,peer))throw new IllegalArgumentException("group_contact_required");result.add(id);
        }}return List.copyOf(result);
    }
    private void groupNotify(String id,String sender,long seq) {
        try{for(String recipient:groups.get(id).members.keySet())if(!recipient.equals(identities.id(sender)))notifications.enqueue(recipient,id,seq);}
        catch(IOException|IllegalArgumentException error){System.err.println("Group notification enqueue pending: "+error.getClass().getSimpleName());}
    }
    private void groupApi(HttpExchange exchange,String action,boolean write) throws IOException,BadRequest {
        String user;
        if(!write&&action.equals("avatar")){String requested=identities.username(params(exchange).get("accountId"));Sessions.Access access=requested==null?null:session(exchange,requested);if(access==null){json(exchange,401,"{\"error\":\"unauthorized\"}");return;}user=access.username();}
        else{user=requireUser(exchange);if(user==null)return;}String uid=identities.id(user);
        try{
            Map<String,String> f;
            if(write&&action.equals("avatar")){
                f=params(exchange);byte[] bytes=exchange.getRequestBody().readNBytes(Avatars.MAX_UPLOAD+1);if(bytes.length>Avatars.MAX_UPLOAD)throw new IllegalArgumentException("avatar_too_large");
                if(!"application/octet-stream".equalsIgnoreCase(exchange.getRequestHeaders().getFirst("Content-Type")))throw new BadRequest();
                var g=groups.avatar(f.get("id"),uid,Long.parseLong(f.getOrDefault("version","0")),bytes);json(exchange,200,groupJson(g,user));return;
            }
            f=write?form(exchange,action.equals("articles/send")||action.equals("messages/edit")?ChatStore.ARTICLE_BYTES*3+4096:MAX_BODY):params(exchange);
            if(write&&!rates.allow("group-action:"+uid,120,60)){json(exchange,429,"{\"error\":\"rate_limited\"}");return;}
            String id=f.get("id"),topic=f.getOrDefault("topic","general");
            if(!write&&action.equals("list")){
                List<String> rows=new ArrayList<>();for(var g:groups.list(uid,f.getOrDefault("query",""),"true".equals(f.get("global"))))rows.add(groupJson(g,user));
                json(exchange,200,"{\"groups\":["+String.join(",",rows)+"]}");return;
            }
            if(!write&&action.equals("invite")){json(exchange,200,groupJson(groups.resolveInvite(f.get("token")),user));return;}
            if(!write&&action.equals("avatar")){byte[] bytes=groups.avatarBytes(id,uid);if(bytes==null){json(exchange,404,"{\"error\":\"avatar_not_found\"}");return;}exchange.getResponseHeaders().set("Content-Type","image/png");exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);return;}
            if(write&&action.equals("create")){
                if(identities.username(id)!=null)throw new IllegalArgumentException("invalid_group");List<String> members=groupContactIds(user,f.get("members"));
                json(exchange,201,groupJson(groups.create(id,uid,f.getOrDefault("name",""),members),user));return;
            }
            if(write&&action.equals("join")){synchronized(relations){synchronized(groups){var g=groups.join(uid,id,f.get("token"),chats.lastSequence(user,GroupStore.peer(id)));json(exchange,200,groupJson(g,user));}}return;}
            if(!write&&action.equals("profile")){var g=groups.get(id);if(!g.members.containsKey(uid)&&!g.type.equals("public"))throw new IllegalArgumentException("group_not_member");json(exchange,200,groupJson(g,user));return;}
            if(write&&action.equals("members/add")){List<String> members=groupContactIds(user,f.get("members"));synchronized(relations){synchronized(groups){var g=groups.add(id,uid,members,chats.lastSequence(user,GroupStore.peer(id)));json(exchange,200,groupJson(g,user));}}return;}
            synchronized(relations){synchronized(groups){
                GroupStore.Group g=groups.member(id,uid);String peer=GroupStore.peer(id);long floor=g.members.get(uid).floor();
                if(!write&&action.equals("messages")){
                    int limit=Integer.parseInt(f.getOrDefault("limit","50"));long before=Long.parseLong(f.getOrDefault("before","0")),after=Long.parseLong(f.getOrDefault("after","0"));
                    if(limit<1||limit>100||before<0||after<0||!g.topics.containsKey(topic))throw new BadRequest();
                    String filter=g.topicsEnabled?topic:null;
                    var page=f.containsKey("after")?chats.messagesAfter(user,peer,Math.max(after,floor),limit,filter):chats.messages(user,peer,before,limit,f.getOrDefault("q",f.getOrDefault("query","")),filter,floor);
                    List<String> rows=new ArrayList<>();for(var message:page.messages())rows.add(groupMessageJson(g,user,message));
                    json(exchange,200,"{\"messages\":["+String.join(",",rows)+"],\"more\":"+page.more()+",\"revision\":"+page.revision()+groupReceipts(g,user,topic)+",\"profile\":"+groupJson(g,user)+"}");return;
                }
                if(!write&&action.equals("messages/changes")){
                    long after=Long.parseLong(f.getOrDefault("after","0"));int limit=Integer.parseInt(f.getOrDefault("limit","100"));if(after<0||limit<1||limit>100)throw new BadRequest();
                    var page=chats.changes(user,peer,after,limit);List<String> rows=new ArrayList<>();for(var message:page.updates())if(message.seq()>floor&&(!g.topicsEnabled||message.topic().equals(topic)))rows.add(groupMessageJson(g,user,message));
                    json(exchange,200,"{\"updates\":["+String.join(",",rows)+"],\"more\":"+page.more()+",\"revision\":"+page.revision()+groupReceipts(g,user,topic)+"}");return;
                }
                if(!write&&action.equals("reactions")){
                    long after=Long.parseLong(f.getOrDefault("after","0"));var page=chats.messages(user,peer,0,100,"",g.topicsEnabled?topic:null,floor);List<String> rows=new ArrayList<>();
                    for(var message:page.messages())if(message.seq()>=after)rows.add(groupMessageState(g,user,message));json(exchange,200,"{\"states\":["+String.join(",",rows)+"]}");return;
                }
                if(write&&action.equals("read")){long seq=Long.parseLong(f.getOrDefault("seq","0"));if(seq<=floor||seq>chats.lastSequence(user,peer)||g.topicsEnabled&&!chats.notificationMessage(user,peer,seq).topic().equals(topic))throw new BadRequest();readReceipts.mark(uid,groupReceiptId(g,topic),seq);json(exchange,200,"{\"ok\":true"+groupReceipts(g,user,topic)+"}");return;}
                if(write&&(action.equals("messages/send")||action.equals("articles/send"))){
                    boolean article=action.equals("articles/send");groups.checkSend(id,uid,article?"article":"text",topic);String content=f.get("text");ChatStore.Message message;
                    boolean committed=true;if(article){String request=f.get("requestId");if(!AccountIdentities.validId(request))throw new IllegalArgumentException("invalid_article");committed=chats.findAttachment(user,peer,request)==null;message=chats.sendArticle(user,peer,content,request,topic);}
                    else message=chats.sendAttachment(user,peer,content==null?null:content.strip(),null,topic);
                    if(committed)groupNotify(id,user,message.seq());json(exchange,201,"{\"message\":"+groupMessageJson(g,user,message)+"}");return;
                }
                if(write&&(action.equals("messages/edit")||action.equals("messages/retract")||action.equals("messages/favorite")||action.equals("react"))){
                    long seq=Long.parseLong(f.getOrDefault("seq","0"));ChatStore.Message old=chats.notificationMessage(user,peer,seq);if(old.seq()<=floor)throw new IllegalArgumentException("message_not_found");ChatStore.Message result;
                    if(action.equals("messages/edit")){groups.checkSend(id,uid,old.attachment()==null?"text":old.attachment().kind(),old.topic());result=chats.edit(user,peer,seq,Long.parseLong(f.getOrDefault("version","0")),f.get("text"));}
                    else if(action.equals("messages/retract")){result=chats.retract(user,peer,seq,GroupStore.manages(g,uid,"deleteMessages"));removePin(user,peer,seq);}
                    else if(action.equals("react")){if(old.deleted())throw new IllegalArgumentException("message_retracted");groups.react(id,uid,seq,f.get("emoji"));g=groups.get(id);result=old;}
                    else {result=chats.favorite(user,peer,seq);json(exchange,200,"{\"message\":"+messageJson(result)+"}");return;}
                    json(exchange,200,"{\"message\":"+groupMessageJson(g,user,result)+"}");return;
                }
                if(write&&action.equals("save")){json(exchange,200,groupJson(groups.save(id,uid,Long.parseLong(f.getOrDefault("version","0")),f),user));return;}
                if(write&&action.equals("avatar/reset")){json(exchange,200,groupJson(groups.avatar(id,uid,Long.parseLong(f.getOrDefault("version","0")),null),user));return;}
                if(write&&action.equals("members/remove")){json(exchange,200,groupJson(groups.remove(id,uid,f.get("userId")),user));return;}
                if(write&&action.equals("members/role")){var rights=f.getOrDefault("rights","");json(exchange,200,groupJson(groups.role(id,uid,f.get("userId"),f.get("role"),rights.isEmpty()?java.util.Set.of():new java.util.HashSet<>(List.of(rights.split(",")))),user));return;}
                if(write&&action.equals("leave")){groups.remove(id,uid,uid);json(exchange,200,"{\"ok\":true}");return;}
                if(write&&action.equals("delete")){groups.delete(id,uid);json(exchange,200,"{\"ok\":true}");return;}
                if(write&&action.equals("invites/create")){
                    var updated=f.containsKey("days")?groups.createInvite(id,uid,Integer.parseInt(f.get("days")),Integer.parseInt(f.getOrDefault("limit","0")))
                        :groups.invite(id,uid,null,Long.parseLong(f.getOrDefault("expires","0")),Integer.parseInt(f.getOrDefault("limit","0")));
                    json(exchange,200,groupJson(updated,user));return;
                }
                if(write&&action.equals("invites/edit")){
                    json(exchange,200,groupJson(groups.editInvite(id,uid,f.get("token"),Long.parseLong(f.get("expectedExpires")),Integer.parseInt(f.get("expectedLimit")),
                        f.containsKey("days")?Integer.valueOf(f.get("days")):null,Integer.parseInt(f.get("limit"))),user));return;
                }
                if(write&&action.equals("invites/revoke")){json(exchange,200,groupJson(groups.invite(id,uid,f.get("token"),0,0),user));return;}
                if(write&&action.equals("topics/save")){json(exchange,200,groupJson(groups.topic(id,uid,f.get("topicId"),f.getOrDefault("title",""),"true".equals(f.get("closed"))),user));return;}
            }}
            json(exchange,404,"{\"error\":\"not_found\"}");
        }catch(ChatStore.ActionException error){json(exchange,error.reason.equals("message_not_yours")?403:409,"{\"error\":"+quote(error.reason)+"}");}
        catch(IllegalArgumentException error){String reason=error.getMessage()==null?"invalid_group":error.getMessage();int code=reason.equals("group_not_found")?404:reason.equals("group_changed")||reason.equals("group_invite_changed")?409:reason.equals("group_not_member")||reason.equals("group_permission_denied")||reason.equals("group_owner_required")?403:400;json(exchange,code,"{\"error\":"+quote(reason)+"}");}
    }

    private void saveContact(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("relations:" + user, 120, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}"); return;
        }
        Map<String, String> values = form(exchange);
        String peer = checkedPeer(exchange, user, values.get("peer"), false);
        if (peer == null) return;
        String alias = values.getOrDefault("alias", "");
        if (!RelationsStore.validAlias(alias)) {
            json(exchange, 400, "{\"error\":\"invalid_alias\"}"); return;
        }
        synchronized (relations) {
            relations.saveContact(user, peer, alias);
            json(exchange, 200, "{\"ok\":true,\"profile\":" + personJson(user, peer) + "}");
        }
    }

    private void removeContact(HttpExchange exchange) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("relations:" + user, 120, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}"); return;
        }
        String peer = checkedPeer(exchange, user, form(exchange).get("peer"), false);
        if (peer == null) return;
        if (relations.removeContact(user, peer)) json(exchange, 200, "{\"ok\":true}");
        else json(exchange, 404, "{\"error\":\"contact_not_found\"}");
    }

    private void setBlock(HttpExchange exchange, boolean blocked) throws IOException, BadRequest {
        String user = requireUser(exchange);
        if (user == null) return;
        if (!rates.allow("relations:" + user, 120, 60)) {
            json(exchange, 429, "{\"error\":\"rate_limited\"}"); return;
        }
        String peer = checkedPeer(exchange, user, form(exchange).get("peer"), false);
        if (peer == null) return;
        synchronized (relations) {
            relations.setBlocked(user, peer, blocked);
            json(exchange, 200, "{\"ok\":true,\"profile\":" + personJson(user, peer) + "}");
        }
    }

    private String requireUser(HttpExchange exchange) throws IOException {
        BrowserAccounts.Access browser = browserAccounts.access(browserToken(exchange));
        if (browser != null && browser.renewed()) setBrowserCookie(exchange, browserToken(exchange));
        if (browser != null && browser.users().size() > 1 && exchange.getRequestHeaders().getFirst("X-Chawe-Account") == null) {
            json(exchange, 409, "{\"error\":\"client_update_required\"}");
            return null;
        }
        Sessions.Access access = session(exchange);
        if (access == null) json(exchange, 401, "{\"error\":\"unauthorized\"}");
        else if (!identities.id(access.username()).equals(exchange.getRequestHeaders().getFirst("X-Chawe-Identity"))) {
            json(exchange,401,"{\"error\":\"unauthorized\"}"); return null;
        }
        return access == null ? null : access.username();
    }

    private Sessions.Access session(HttpExchange exchange) throws IOException {
        return session(exchange, exchange.getRequestHeaders().getFirst("X-Chawe-Account"));
    }

    private Sessions.Access session(HttpExchange exchange, String requested) throws IOException {
        if (requested != null && !AccountStore.validUsername(requested)) return null;
        String browserValue = browserToken(exchange);
        BrowserAccounts.Access browser = browserAccounts.access(browserValue);
        if (browser != null) {
            if (browser.renewed()) setBrowserCookie(exchange, browserValue);
            String user = requested == null ? browser.selected() : requested;
            return browser.users().contains(user) && accounts.exists(user) ? new Sessions.Access(user, false) : null;
        }
        String value = token(exchange);
        Sessions.Access access = sessions.access(value);
        if (access != null && requested != null && !requested.equals(access.username())) return null;
        if (access != null && access.renewed()) setCookie(exchange, value);
        return access;
    }

    private Map<String, String> params(HttpExchange exchange) throws BadRequest {
        String raw = exchange.getRequestURI().getRawQuery();
        if (raw == null || raw.isEmpty()) return Map.of();
        if (raw.length() > 1024) throw new BadRequest();
        return decodePairs(raw);
    }

    private String messageJson(ChatStore.Message m) {return messageJson(m,null);}
    private String messageJson(ChatStore.Message m,String groupViewer) {
        var a = m.deleted() ? null : m.attachment();
        String text = m.text();
        // Group history remains readable after the upload owner or the last voice recipient is deleted.
        if(a != null && a.kind().startsWith("voice")) {
            try { voices.find(a.id()); }
            catch(IllegalArgumentException error) {
                if(!"voice_not_found".equals(error.getMessage())) throw error;
                a = null; if(text.isEmpty()) text = "语音已删除";
            }
        }
        String attachment = a == null ? "null" : "{\"id\":" + quote(a.id()) + ",\"name\":" + quote(a.kind().equals("article") ? ChatStore.articleTitle(m.text()) : a.name())
            + ",\"type\":" + quote(a.type()) + ",\"size\":" + (a.kind().equals("article") ? m.text().getBytes(StandardCharsets.UTF_8).length : a.size()) + ",\"kind\":" + quote(a.kind())
            + (a.kind().startsWith("voice") ? voices.extraJson(a.id(),groupViewer) : "") + "}";
        return "{\"seq\":" + m.seq() + ",\"time\":" + m.time() + ",\"sender\":" + quote(m.sender())
            + ",\"text\":" + quote(text) + ",\"revision\":" + m.revision()
            + ",\"editedAt\":" + m.editedAt() + ",\"deleted\":" + m.deleted() + ",\"attachment\":" + attachment + "}";
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '"' || ch == '\\') result.append('\\').append(ch);
            else if (ch < 32) result.append(String.format("\\u%04x", (int) ch));
            else result.append(ch);
        }
        return result.append('"').toString();
    }

    private void home(HttpExchange exchange) throws IOException, BadRequest {
        Sessions.Access access = session(exchange);
        if (access != null && !"1".equals(params(exchange).get("add-account"))) {
            String invite=params(exchange).get("invite");
            exchange.getResponseHeaders().set("Location", "/app?account=" + access.username()+(AccountIdentities.validId(invite)?"&invite="+invite:""));
            exchange.sendResponseHeaders(302, -1);
            return;
        }
        staticFile(exchange, "index.html", "text/html; charset=utf-8");
    }

    private void app(HttpExchange exchange) throws IOException, BadRequest {
        Map<String,String> query = params(exchange);
        String requested = query.containsKey("accountId") ? identities.username(query.get("accountId")) : query.get("account");
        if (query.containsKey("accountId") && requested == null) throw new BadRequest();
        if (requested != null && !AccountStore.validUsername(requested)) throw new BadRequest();
        if (session(exchange, requested) == null) {
            String redirect=requested==null?"/?":"/?add-account=1&return-account="+requested+"&",invite=query.get("invite");
            exchange.getResponseHeaders().set("Location",redirect+(AccountIdentities.validId(invite)?"invite="+invite:""));
            exchange.sendResponseHeaders(302, -1);
            return;
        }
        staticFile(exchange, "chat.html", "text/html; charset=utf-8");
    }

    private Map<String, String> form(HttpExchange exchange) throws IOException, BadRequest {
        return form(exchange,MAX_BODY);
    }
    private Map<String, String> form(HttpExchange exchange,int limit) throws IOException, BadRequest {
        String type = exchange.getRequestHeaders().getFirst("Content-Type");
        if (type == null || !type.equalsIgnoreCase("application/x-www-form-urlencoded")) throw new BadRequest();
        byte[] bytes = exchange.getRequestBody().readNBytes(limit + 1);
        if (bytes.length > limit) throw new BadRequest();
        String body = new String(bytes, StandardCharsets.UTF_8);
        return decodePairs(body);
    }

    private Map<String, String> decodePairs(String body) throws BadRequest {
        Map<String, String> result = new HashMap<>();
        try {
            for (String pair : body.split("&")) {
                String[] parts = pair.split("=", 2);
                if (parts.length != 2) throw new BadRequest();
                String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8);
                String value = URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
                if (result.putIfAbsent(key, value) != null) throw new BadRequest();
            }
        } catch (IllegalArgumentException e) {
            throw new BadRequest();
        }
        return result;
    }

    private String token(HttpExchange exchange) {
        return cookie(exchange, "__Host-chawe_session");
    }

    private String browserToken(HttpExchange exchange) {
        return cookie(exchange, "__Host-chawe_accounts");
    }

    private String cookie(HttpExchange exchange, String name) {
        String cookie = exchange.getRequestHeaders().getFirst("Cookie");
        if (cookie == null) return null;
        for (String item : cookie.split(";")) {
            String trimmed = item.trim();
            if (trimmed.startsWith(name + "=")) return trimmed.substring(name.length() + 1);
        }
        return null;
    }

    private String clientIp(HttpExchange exchange) {
        String address = exchange.getRequestHeaders().getFirst("X-Real-IP");
        if (address != null && address.length() <= 80) return address;
        return exchange.getRemoteAddress().getAddress().getHostAddress();
    }

    private void setCookie(HttpExchange exchange, String token) {
        exchange.getResponseHeaders().add("Set-Cookie", "__Host-chawe_session=" + token
            + "; Path=/; Max-Age=" + Sessions.LIFETIME + "; HttpOnly; Secure; SameSite=Strict");
    }

    private void setBrowserCookie(HttpExchange exchange, String value) {
        exchange.getResponseHeaders().add("Set-Cookie", "__Host-chawe_accounts=" + value
            + "; Path=/; Max-Age=" + Sessions.LIFETIME + "; HttpOnly; Secure; SameSite=Strict");
    }

    private void clearCookie(HttpExchange exchange, String name) {
        exchange.getResponseHeaders().add("Set-Cookie", name + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    }

    private void staticFile(HttpExchange exchange, String name, String type) throws IOException {
        byte[] bytes = Files.readAllBytes(webDir.resolve(name));
        exchange.getResponseHeaders().set("Content-Type", type);
        if (name.equals("article-editor.js") || name.equals("article-editor.css")) {
            String query = exchange.getRequestURI().getRawQuery();
            var revision = java.util.regex.Pattern.compile("(?:^|&)v=([a-f0-9]{64})(?:&|$)").matcher(query == null ? "" : query);
            if (revision.find()) {
                try {
                    String actual = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                    if (actual.equals(revision.group(1))) {
                        exchange.getResponseHeaders().set("Cache-Control", "public, max-age=31536000, immutable");
                    }
                } catch (java.security.NoSuchAlgorithmException error) {
                    throw new IOException("SHA-256 unavailable",error);
                }
            }
        }
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private void json(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        if (exchange.getRequestMethod().equals("HEAD")) {
            exchange.getResponseHeaders().set("Content-Length",Integer.toString(bytes.length));
            exchange.sendResponseHeaders(status,-1); return;
        }
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private void commonHeaders(HttpExchange exchange) {
        var headers = exchange.getResponseHeaders();
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Content-Security-Policy", csp);
    }

    private static String between(String source, String start, String end) throws IOException {
        int first = source.indexOf(start);
        if (first < 0) throw new IOException("Missing inline script: " + start);
        int bodyStart = first + start.length();
        int bodyEnd = source.indexOf(end, bodyStart);
        if (bodyEnd < 0) throw new IOException("Unterminated inline script");
        return source.substring(bodyStart, bodyEnd);
    }

    private static String scriptHash(String source) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8));
            return "'sha256-" + Base64.getEncoder().encodeToString(digest) + "'";
        } catch (Exception e) {
            throw new IllegalStateException("CSP hash failed", e);
        }
    }

    private static final class BadRequest extends Exception { }
}
