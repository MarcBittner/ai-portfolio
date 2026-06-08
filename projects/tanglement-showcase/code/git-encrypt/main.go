package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	KeyPath    string `json:"keyPath"`
	Operation  string `json:"operation"`
	ConfigFile string `json:"configFile"`
	Verbose    bool   `json:"verbose"`
}

type EncryptionMetadata struct {
	Version   string    `json:"version"`
	Timestamp time.Time `json:"timestamp"`
	FileCount int       `json:"fileCount"`
	KeyHash   string    `json:"keyHash"`
}

func main() {
	var config Config
	flag.StringVar(&config.KeyPath, "key", "", "Path to SSH private key file")
	flag.StringVar(&config.Operation, "operation", "", "Operation to perform: encrypt or decrypt")
	flag.StringVar(&config.ConfigFile, "config", "", "Path to configuration file")
	flag.BoolVar(&config.Verbose, "verbose", false, "Enable verbose output")
	flag.Parse()

	if config.ConfigFile != "" {
		if err := loadConfig(config.ConfigFile, &config); err != nil {
			fmt.Fprintf(os.Stderr, "Error loading config file: %v\n", err)
			os.Exit(1)
		}
	}

	if config.KeyPath == "" {
		fmt.Fprintf(os.Stderr, "Error: --key parameter is required\n")
		flag.Usage()
		os.Exit(1)
	}

	if config.Operation == "" {
		fmt.Fprintf(os.Stderr, "Error: --operation parameter is required (encrypt or decrypt)\n")
		flag.Usage()
		os.Exit(1)
	}

	if config.Operation != "encrypt" && config.Operation != "decrypt" {
		fmt.Fprintf(os.Stderr, "Error: operation must be 'encrypt' or 'decrypt'\n")
		os.Exit(1)
	}

	repoRoot, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error getting current directory: %v\n", err)
		os.Exit(1)
	}

	if config.Verbose {
		fmt.Printf("Repository root: %s\n", repoRoot)
		fmt.Printf("Key path: %s\n", config.KeyPath)
		fmt.Printf("Operation: %s\n", config.Operation)
	}

	switch config.Operation {
	case "encrypt":
		if err := encryptRepository(repoRoot, config.KeyPath, config.Verbose); err != nil {
			fmt.Fprintf(os.Stderr, "Encryption failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Repository encrypted successfully")
	case "decrypt":
		if err := decryptRepository(repoRoot, config.KeyPath, config.Verbose); err != nil {
			fmt.Fprintf(os.Stderr, "Decryption failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Repository decrypted successfully")
	}
}

func loadConfig(configPath string, config *Config) error {
	file, err := os.Open(configPath)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewDecoder(file).Decode(config)
}

func loadPrivateKey(keyPath string) (interface{}, error) {
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read key file: %v", err)
	}

	block, _ := pem.Decode(keyData)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	switch block.Type {
	case "RSA PRIVATE KEY":
		return x509.ParsePKCS1PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		return x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		return x509.ParsePKCS8PrivateKey(block.Bytes)
	default:
		return nil, fmt.Errorf("unsupported key type: %s", block.Type)
	}
}

func getKeyHash(privateKey interface{}) string {
	var publicKeyBytes []byte
	var err error

	switch key := privateKey.(type) {
	case *rsa.PrivateKey:
		publicKeyBytes, err = x509.MarshalPKIXPublicKey(&key.PublicKey)
	case *ecdsa.PrivateKey:
		publicKeyBytes, err = x509.MarshalPKIXPublicKey(&key.PublicKey)
	default:
		return "unsupported_key_type"
	}

	if err != nil {
		return "hash_error"
	}

	hash := sha256.Sum256(publicKeyBytes)
	return base64.StdEncoding.EncodeToString(hash[:])
}

func encryptWithKey(data []byte, privateKey interface{}) ([]byte, error) {
	switch key := privateKey.(type) {
	case *rsa.PrivateKey:
		return rsa.EncryptOAEP(sha256.New(), rand.Reader, &key.PublicKey, data, nil)
	case *ecdsa.PrivateKey:
		return encryptWithECDSA(data, key)
	default:
		return nil, fmt.Errorf("unsupported key type for encryption")
	}
}

func decryptWithKey(data []byte, privateKey interface{}) ([]byte, error) {
	switch key := privateKey.(type) {
	case *rsa.PrivateKey:
		return rsa.DecryptOAEP(sha256.New(), rand.Reader, key, data, nil)
	case *ecdsa.PrivateKey:
		return decryptWithECDSA(data, key)
	default:
		return nil, fmt.Errorf("unsupported key type for decryption")
	}
}

func encryptWithECDSA(data []byte, privateKey *ecdsa.PrivateKey) ([]byte, error) {
	ephemeralKey, err := ecdsa.GenerateKey(privateKey.Curve, rand.Reader)
	if err != nil {
		return nil, err
	}

	sharedX, _ := privateKey.Curve.ScalarMult(privateKey.PublicKey.X, privateKey.PublicKey.Y, ephemeralKey.D.Bytes())
	sharedSecret := sha256.Sum256(sharedX.Bytes())

	encrypted := make([]byte, len(data))
	for i, b := range data {
		encrypted[i] = b ^ sharedSecret[i%32]
	}

	ephemeralPubBytes := elliptic.Marshal(privateKey.Curve, ephemeralKey.PublicKey.X, ephemeralKey.PublicKey.Y)
	keyLenBytes := []byte(fmt.Sprintf("%04d", len(ephemeralPubBytes)))
	
	result := append(keyLenBytes, ephemeralPubBytes...)
	result = append(result, encrypted...)
	
	return result, nil
}

func decryptWithECDSA(data []byte, privateKey *ecdsa.PrivateKey) ([]byte, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("invalid encrypted data format")
	}

	var keyLen int
	if _, err := fmt.Sscanf(string(data[:4]), "%04d", &keyLen); err != nil {
		return nil, fmt.Errorf("invalid key length format")
	}

	if len(data) < 4+keyLen {
		return nil, fmt.Errorf("invalid encrypted data format")
	}

	ephemeralPubBytes := data[4 : 4+keyLen]
	ephemeralPubX, ephemeralPubY := elliptic.Unmarshal(privateKey.Curve, ephemeralPubBytes)
	if ephemeralPubX == nil {
		return nil, fmt.Errorf("invalid ephemeral public key")
	}

	sharedX, _ := privateKey.Curve.ScalarMult(ephemeralPubX, ephemeralPubY, privateKey.D.Bytes())
	sharedSecret := sha256.Sum256(sharedX.Bytes())

	encryptedData := data[4+keyLen:]
	decrypted := make([]byte, len(encryptedData))
	for i, b := range encryptedData {
		decrypted[i] = b ^ sharedSecret[i%32]
	}

	return decrypted, nil
}

func loadGitignorePatterns(repoRoot string) ([]string, error) {
	patterns := []string{".git/", ".encrypted_metadata.json"}
	gitignorePath := filepath.Join(repoRoot, ".gitignore")

	file, err := os.Open(gitignorePath)
	if err != nil {
		if os.IsNotExist(err) {
			return patterns, nil
		}
		return nil, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" && !strings.HasPrefix(line, "#") {
			patterns = append(patterns, line)
		}
	}
	return patterns, scanner.Err()
}

func shouldIgnoreFile(filePath, repoRoot string, patterns []string) bool {
	relPath, err := filepath.Rel(repoRoot, filePath)
	if err != nil {
		return true
	}

	for _, pattern := range patterns {
		if matched, _ := filepath.Match(pattern, relPath); matched {
			return true
		}
		if strings.HasPrefix(relPath, pattern) {
			return true
		}
		if strings.HasSuffix(pattern, "/") {
			dirPattern := strings.TrimSuffix(pattern, "/")
			if strings.HasPrefix(relPath, dirPattern+"/") || relPath == dirPattern {
				return true
			}
		}
	}
	return false
}

func getFilesToProcess(repoRoot string, patterns []string) ([]string, error) {
	var files []string
	err := filepath.Walk(repoRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && !shouldIgnoreFile(path, repoRoot, patterns) {
			files = append(files, path)
		}
		return nil
	})
	return files, err
}

func encryptFile(filePath string, privateKey interface{}) error {
	plaintext, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("failed to read file %s: %v", filePath, err)
	}

	ciphertext, err := encryptWithKey(plaintext, privateKey)
	if err != nil {
		return encryptFileHybrid(filePath, plaintext, privateKey)
	}
	return os.WriteFile(filePath, ciphertext, 0644)
}

func encryptFileHybrid(filePath string, plaintext []byte, privateKey interface{}) error {
	aesKey := make([]byte, 32)
	if _, err := rand.Read(aesKey); err != nil {
		return fmt.Errorf("failed to generate AES key: %v", err)
	}

	encrypted := make([]byte, len(plaintext))
	for i := range plaintext {
		encrypted[i] = plaintext[i] ^ aesKey[i%len(aesKey)]
	}

	encryptedKey, err := encryptWithKey(aesKey, privateKey)
	if err != nil {
		return fmt.Errorf("failed to encrypt AES key: %v", err)
	}

	keyLenBytes := []byte(fmt.Sprintf("%04d", len(encryptedKey)))
	result := append(keyLenBytes, encryptedKey...)
	result = append(result, encrypted...)
	return os.WriteFile(filePath, result, 0644)
}

func decryptFile(filePath string, privateKey interface{}) error {
	ciphertext, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("failed to read file %s: %v", filePath, err)
	}

	plaintext, err := decryptWithKey(ciphertext, privateKey)
	if err == nil {
		return os.WriteFile(filePath, plaintext, 0644)
	}
	return decryptFileHybrid(filePath, ciphertext, privateKey)
}

func decryptFileHybrid(filePath string, ciphertext []byte, privateKey interface{}) error {
	if len(ciphertext) < 4 {
		return fmt.Errorf("invalid encrypted file format")
	}

	var keyLen int
	if _, err := fmt.Sscanf(string(ciphertext[:4]), "%04d", &keyLen); err != nil {
		return fmt.Errorf("invalid key length format: %v", err)
	}

	if len(ciphertext) < 4+keyLen {
		return fmt.Errorf("invalid encrypted file format")
	}

	encryptedKey := ciphertext[4 : 4+keyLen]
	aesKey, err := decryptWithKey(encryptedKey, privateKey)
	if err != nil {
		return fmt.Errorf("failed to decrypt AES key: %v", err)
	}

	encryptedData := ciphertext[4+keyLen:]
	plaintext := make([]byte, len(encryptedData))
	for i := range encryptedData {
		plaintext[i] = encryptedData[i] ^ aesKey[i%len(aesKey)]
	}
	return os.WriteFile(filePath, plaintext, 0644)
}

func encryptRepository(repoRoot, keyPath string, verbose bool) error {
	privateKey, err := loadPrivateKey(keyPath)
	if err != nil {
		return fmt.Errorf("failed to load private key: %v", err)
	}

	patterns, err := loadGitignorePatterns(repoRoot)
	if err != nil {
		return fmt.Errorf("failed to load gitignore patterns: %v", err)
	}

	files, err := getFilesToProcess(repoRoot, patterns)
	if err != nil {
		return fmt.Errorf("failed to get files to process: %v", err)
	}

	if verbose {
		fmt.Printf("Found %d files to encrypt\n", len(files))
	}

	successCount := 0
	for _, file := range files {
		if err := encryptFile(file, privateKey); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to encrypt %s: %v\n", file, err)
		} else {
			successCount++
			if verbose {
				fmt.Printf("Encrypted: %s\n", file)
			}
		}
	}

	metadata := EncryptionMetadata{
		Version:   "1.0",
		Timestamp: time.Now(),
		FileCount: successCount,
		KeyHash:   getKeyHash(privateKey),
	}

	metadataPath := filepath.Join(repoRoot, ".encrypted_metadata.json")
	metadataFile, err := os.Create(metadataPath)
	if err != nil {
		return fmt.Errorf("failed to create metadata file: %v", err)
	}
	defer metadataFile.Close()

	encoder := json.NewEncoder(metadataFile)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(metadata); err != nil {
		return fmt.Errorf("failed to write metadata: %v", err)
	}

	fmt.Printf("Successfully encrypted %d files\n", successCount)
	return nil
}

func decryptRepository(repoRoot, keyPath string, verbose bool) error {
	metadataPath := filepath.Join(repoRoot, ".encrypted_metadata.json")
	if _, err := os.Stat(metadataPath); os.IsNotExist(err) {
		return fmt.Errorf("no encryption metadata found - repository may not be encrypted")
	}

	metadataFile, err := os.Open(metadataPath)
	if err != nil {
		return fmt.Errorf("failed to open metadata file: %v", err)
	}
	defer metadataFile.Close()

	var metadata EncryptionMetadata
	decoder := json.NewDecoder(metadataFile)
	if err := decoder.Decode(&metadata); err != nil {
		return fmt.Errorf("failed to read metadata: %v", err)
	}

	privateKey, err := loadPrivateKey(keyPath)
	if err != nil {
		return fmt.Errorf("failed to load private key: %v", err)
	}

	keyHash := getKeyHash(privateKey)
	if keyHash != metadata.KeyHash {
		return fmt.Errorf("key mismatch - wrong decryption key provided")
	}

	patterns, err := loadGitignorePatterns(repoRoot)
	if err != nil {
		return fmt.Errorf("failed to load gitignore patterns: %v", err)
	}

	files, err := getFilesToProcess(repoRoot, patterns)
	if err != nil {
		return fmt.Errorf("failed to get files to process: %v", err)
	}

	if verbose {
		fmt.Printf("Found %d files to decrypt\n", len(files))
	}

	successCount := 0
	for _, file := range files {
		if err := decryptFile(file, privateKey); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to decrypt %s: %v\n", file, err)
		} else {
			successCount++
			if verbose {
				fmt.Printf("Decrypted: %s\n", file)
			}
		}
	}

	if err := os.Remove(metadataPath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove metadata file: %v\n", err)
	}

	fmt.Printf("Successfully decrypted %d files\n", successCount)
	return nil
}
