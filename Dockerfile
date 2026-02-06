FROM node:20

# 1. Instala o Chromium nativo e fontes necessárias
# Isso garante compatibilidade seja qual for a arquitetura do servidor (ARM ou x64)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Força o Puppeteer a usar o Chromium instalado pelo sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 3. Define diretório de trabalho
WORKDIR /app

# 4. Copia arquivos de dependência
COPY package*.json ./

# 5. Instala dependências do projeto
RUN npm install

# 6. Copia o restante do projeto
COPY . .

# 7. Expõe a porta
EXPOSE 3000

# 8. Comando de inicialização
CMD ["node", "server.js"]