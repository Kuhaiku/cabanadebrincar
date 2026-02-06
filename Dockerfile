FROM node:18

# 1. Instala dependências do Chrome/Puppeteer (Necessário para o Venom-bot)
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# 2. Define diretório de trabalho
WORKDIR /app

# 3. Copia arquivos de dependência
COPY package*.json ./

# 4. Instala dependências do projeto
RUN npm install

# 5. Copia o restante do projeto
COPY . .

# 6. Expõe a porta
EXPOSE 3000

# 7. Comando de inicialização
CMD ["node", "server.js"]