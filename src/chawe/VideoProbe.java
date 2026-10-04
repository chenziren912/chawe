package chawe;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/** Reads only media metadata, with bounded processes, time and output. */
final class VideoProbe {
    private static final Semaphore SLOTS = new Semaphore(2);
    private VideoProbe() { }

    static void check(Path file,long maximumSeconds) throws IOException {
        if(!SLOTS.tryAcquire())throw new IllegalArgumentException("attachment_processing_busy");
        Process process=null;
        try {
            process=new ProcessBuilder(List.of("/usr/bin/ffprobe","-v","error",
                "-protocol_whitelist","file,pipe",
                "-format_whitelist","mov,matroska,webm,avi,flv,mpeg,mpegts,ogg,asf",
                "-select_streams","v","-show_entries","stream=codec_type,duration:format=duration",
                "-of","default=noprint_wrappers=1:nokey=0",file.toString()))
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            process.getOutputStream().close();
            if(!process.waitFor(30,TimeUnit.SECONDS))throw new IllegalArgumentException("attachment_video_probe_failed");
            byte[] bytes=process.getInputStream().readNBytes(65537);
            if(process.exitValue()!=0||bytes.length>65536)throw new IllegalArgumentException("attachment_video_invalid");
            boolean video=false;double duration=0;
            for(String line:new String(bytes,StandardCharsets.UTF_8).split("\\R")){
                if(line.equals("codec_type=video"))video=true;
                if(line.startsWith("duration="))try{
                    double value=Double.parseDouble(line.substring(9));
                    if(Double.isFinite(value)&&value>0)duration=Math.max(duration,value);
                }catch(NumberFormatException ignored){ }
            }
            if(!video||duration<=0)throw new IllegalArgumentException("attachment_video_invalid");
            if(duration>maximumSeconds)throw new IllegalArgumentException("attachment_video_too_long");
        }catch(InterruptedException error){
            Thread.currentThread().interrupt();throw new IOException("Video validation interrupted",error);
        }catch(IOException error){
            if(process==null)throw new IllegalArgumentException("attachment_video_probe_failed",error);
            throw error;
        }finally{
            try{if(process!=null){if(process.isAlive())process.destroyForcibly();process.getInputStream().close();}}
            finally{SLOTS.release();}
        }
    }
}
