package ai.keepshop.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Обновление приложения из GitHub Releases: скачать APK, проверить пакет/версию/подпись, открыть установщик Android.
 * Android всё равно спросит подтверждение — тихой установки нет.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private PackageInfo selfInfo(int flags) throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
    }

    private static long code(PackageInfo pi) {
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo pi = selfInfo(0);
            JSObject r = new JSObject();
            r.put("versionName", pi.versionName);
            r.put("versionCode", code(pi));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = Build.VERSION.SDK_INT >= 26
                ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://github.com/")) {
            call.reject("Разрешены только ссылки на github.com");
            return;
        }
        call.setKeepAlive(true);
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File apk = new File(dir, "KeepShop-update.apk");
            try {
                dir.mkdirs();
                if (apk.exists()) apk.delete();
                download(url, apk);

                PackageManager pm = getContext().getPackageManager();
                int sigFlag = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
                PackageInfo pkg = pm.getPackageArchiveInfo(apk.getPath(), sigFlag);
                if (pkg == null) throw new Exception("Файл повреждён или это не APK");
                if (!getContext().getPackageName().equals(pkg.packageName)) throw new Exception("Это APK другого приложения: " + pkg.packageName);
                PackageInfo self = selfInfo(sigFlag);
                if (code(pkg) <= code(self)) throw new Exception("Скачанная версия " + pkg.versionName + " не новее установленной " + self.versionName);
                if (!sameSigner(self, pkg)) {
                    throw new Exception("SIGNATURE: подпись APK отличается от установленного приложения (стоит отладочная сборка?). Удалите приложение и установите APK вручную — данные семьи вернутся из облака");
                }

                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("versionName", pkg.versionName);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                call.setKeepAlive(false);
            }
        }).start();
    }

    private void download(String url, File out) throws Exception {
        String current = url;
        HttpURLConnection c = null;
        // GitHub отдаёт файл через переадресацию на objects.githubusercontent.com
        for (int hop = 0; hop < 6; hop++) {
            c = (HttpURLConnection) new URL(current).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setRequestProperty("User-Agent", "KeepShop-Updater");
            int st = c.getResponseCode();
            if (st >= 300 && st < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null || !loc.startsWith("https://")) throw new Exception("Неверная переадресация");
                current = loc;
                continue;
            }
            if (st != 200) throw new Exception("Ошибка загрузки: HTTP " + st);
            break;
        }
        if (c == null) throw new Exception("Слишком много переадресаций");
        long total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int lastPct = -1, n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                done += n;
                int pct = total > 0 ? (int) (done * 100 / total) : -1;
                if (pct != lastPct) {
                    lastPct = pct;
                    JSObject p = new JSObject();
                    p.put("percent", pct);
                    p.put("bytes", done);
                    notifyListeners("progress", p);
                }
            }
        } finally {
            c.disconnect();
        }
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signers(PackageInfo pi) {
        if (Build.VERSION.SDK_INT >= 28 && pi.signingInfo != null) {
            return pi.signingInfo.hasMultipleSigners() ? pi.signingInfo.getApkContentsSigners() : pi.signingInfo.getSigningCertificateHistory();
        }
        return pi.signatures;
    }

    private static boolean sameSigner(PackageInfo a, PackageInfo b) {
        try {
            Signature[] sa = signers(a), sb = signers(b);
            if (sa == null || sa.length == 0) return false;
            // у некоторых версий Android подпись архива не читается — тогда решает сам установщик
            if (sb == null || sb.length == 0) return true;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] ha = md.digest(sa[sa.length - 1].toByteArray());
            byte[] hb = MessageDigest.getInstance("SHA-256").digest(sb[sb.length - 1].toByteArray());
            // текущий ключ установленного приложения должен совпадать с ключом APK
            for (Signature s : sb) if (Arrays.equals(ha, MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))) return true;
            return Arrays.equals(ha, hb);
        } catch (Exception e) {
            return false;
        }
    }
}
