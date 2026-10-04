package chawe;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** RFC 8291 aes128gcm and RFC 8292 VAPID, using the Java 17 cryptography provider. */
final class WebPushTransport {
    private final KeyPair signing;
    private final String publicKey;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER).build();
    private static final SecureRandom RANDOM = new SecureRandom();
    WebPushTransport(Path directory) throws IOException {
        try {
            Path file = directory.resolve("web-push-keys-v1.tsv");
            if (Files.exists(file)) {
                var lines = Files.readAllLines(file,StandardCharsets.UTF_8);
                if (lines.size() != 3 || !lines.get(0).equals("# chawe-web-push-keys-v1")) throw new IOException("Invalid push keys");
                KeyFactory factory = KeyFactory.getInstance("EC");
                signing = new KeyPair(factory.generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(lines.get(1)))),
                    factory.generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(lines.get(2)))));
                byte[] challenge = "chawe-push-key-validation".getBytes(StandardCharsets.US_ASCII);
                Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
                signature.initSign(signing.getPrivate()); signature.update(challenge); byte[] proof = signature.sign();
                signature.initVerify(signing.getPublic()); signature.update(challenge);
                if (!signature.verify(proof)) throw new IOException("Push key pair mismatch");
            } else {
                signing = generate();
                RenameTransaction.atomicWrite(file,("# chawe-web-push-keys-v1\n" + Base64.getEncoder().encodeToString(signing.getPublic().getEncoded())
                    + "\n" + Base64.getEncoder().encodeToString(signing.getPrivate().getEncoded()) + "\n").getBytes(StandardCharsets.UTF_8));
            }
            publicKey = encoded(raw(signing.getPublic()));
        } catch (GeneralSecurityException | IllegalArgumentException error) { throw new IOException("Cannot load push keys",error); }
    }
    String publicKey() { return publicKey; }
    static URI endpoint(String value) {
        if (value == null || value.length() > 2048) throw new IllegalArgumentException("invalid_push_subscription");
        URI uri = URI.create(value); String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getFragment() != null || host == null
            || uri.getPort() != -1 && uri.getPort() != 443 || uri.getRawPath() == null || uri.getRawPath().length() < 2
            || !(host.equals("fcm.googleapis.com") || host.equals("updates.push.services.mozilla.com")
                // Chromium's non-stable channels also use this Google staging endpoint.
                || (host.equals("jmt17.google.com") && uri.getRawPath().startsWith("/fcm/send/"))
                || host.equals("push.services.mozilla.com") || host.endsWith(".notify.windows.com") || host.equals("web.push.apple.com")))
            throw new IllegalArgumentException("unsupported_push_service");
        return uri;
    }
    static void validate(String endpoint,String key,String auth) {
        endpoint(endpoint);
        try { decodePublic(decode(key)); if (decode(auth).length != 16) throw new GeneralSecurityException(); }
        catch (GeneralSecurityException | IllegalArgumentException error) { throw new IllegalArgumentException("invalid_push_subscription"); }
    }
    int send(String endpoint,String key,String auth,String payload) throws IOException, GeneralSecurityException, InterruptedException {
        URI uri = endpoint(endpoint); byte[] body = encrypt(decode(key),decode(auth),payload.getBytes(StandardCharsets.UTF_8));
        String audience = "https://" + uri.getHost();
        String jwt = encoded("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.US_ASCII)) + "."
            + encoded(("{\"aud\":\"" + audience + "\",\"exp\":" + (Instant.now().getEpochSecond()+3600)
                + ",\"sub\":\"mailto:chenpitang912@gmail.com\"}").getBytes(StandardCharsets.US_ASCII));
        Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
        signature.initSign(signing.getPrivate()); signature.update(jwt.getBytes(StandardCharsets.US_ASCII)); jwt += "." + encoded(signature.sign());
        HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(8)).header("TTL","3600")
            .header("Urgency","normal").header("Content-Encoding","aes128gcm").header("Content-Type","application/octet-stream")
            .header("Authorization","vapid t=" + jwt + ", k=" + publicKey).POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        return client.send(request,HttpResponse.BodyHandlers.discarding()).statusCode();
    }
    private static byte[] encrypt(byte[] recipient,byte[] auth,byte[] payload) throws GeneralSecurityException {
        KeyPair ephemeral = generate(); byte[] sender = raw(ephemeral.getPublic());
        KeyAgreement exchange = KeyAgreement.getInstance("ECDH"); exchange.init(ephemeral.getPrivate()); exchange.doPhase(decodePublic(recipient),true);
        byte[] secret = exchange.generateSecret();
        byte[] ikm = expand(hmac(auth,secret),concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII),recipient,sender),32);
        byte[] salt = new byte[16]; RANDOM.nextBytes(salt); byte[] prk = hmac(salt,ikm);
        byte[] cek = expand(prk,"Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII),16);
        byte[] nonce = expand(prk,"Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII),12);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(cek,"AES"),new GCMParameterSpec(128,nonce));
        byte[] encrypted = cipher.doFinal(concat(payload,new byte[]{2}));
        return ByteBuffer.allocate(86+encrypted.length).put(salt).putInt(4096).put((byte)65).put(sender).put(encrypted).array();
    }
    private static KeyPair generate() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp256r1")); return generator.generateKeyPair();
    }
    private static PublicKey decodePublic(byte[] point) throws GeneralSecurityException {
        if (point.length != 65 || point[0] != 4) throw new GeneralSecurityException("Invalid P256 point");
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC"); parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
        BigInteger x = new BigInteger(1,Arrays.copyOfRange(point,1,33)), y = new BigInteger(1,Arrays.copyOfRange(point,33,65));
        BigInteger p = ((ECFieldFp)curve.getCurve().getField()).getP();
        if (x.compareTo(p) >= 0 || y.compareTo(p) >= 0 || !y.multiply(y).mod(p).equals(x.pow(3).add(curve.getCurve().getA().multiply(x)).add(curve.getCurve().getB()).mod(p)))
            throw new GeneralSecurityException("Invalid P256 point");
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x,y),curve));
    }
    private static byte[] raw(PublicKey key) {
        ECPublicKey ec = (ECPublicKey)key;
        return concat(new byte[]{4},coordinate(ec.getW().getAffineX()),coordinate(ec.getW().getAffineY()));
    }
    private static byte[] coordinate(BigInteger number) { byte[] source = number.toByteArray(), result = new byte[32]; int size = Math.min(source.length,32); System.arraycopy(source,source.length-size,result,32-size,size); return result; }
    private static byte[] hmac(byte[] key,byte[] value) throws GeneralSecurityException { Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key,"HmacSHA256")); return mac.doFinal(value); }
    private static byte[] expand(byte[] key,byte[] info,int length) throws GeneralSecurityException { return Arrays.copyOf(hmac(key,concat(info,new byte[]{1})),length); }
    private static byte[] concat(byte[]... arrays) { int length = 0; for (byte[] value : arrays) length += value.length; ByteBuffer out = ByteBuffer.allocate(length); for (byte[] value : arrays) out.put(value); return out.array(); }
    private static byte[] decode(String value) { if (value == null || !value.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException(); return Base64.getUrlDecoder().decode(value); }
    private static String encoded(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
}
