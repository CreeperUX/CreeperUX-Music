# Sonus keeps no reflection-based serialization: the JSON is read by hand (core/Json.kt).
# OkHttp and Media3 ship their own consumer rules.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
